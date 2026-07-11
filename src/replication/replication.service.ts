import { Injectable, Logger, OnModuleInit, StreamableFile, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { EnvVariables, ReplicationRole } from "src/config/config.validator";
import { AbstractFileSystem } from "src/file-system/abstract-file-system.interface";
import * as path from "path";
import {
    createCipheriv,
    randomBytes,
    createDecipheriv,
    createHash
} from "crypto";
import { PassThrough, Readable } from "stream";
import { Response } from "express";
import { minimatch } from "minimatch";
import type Redis from "ioredis";
import { REDIS_CACHE } from "src/util";
import { EmailService } from "src/admin/email.service";
import { createConnection } from "mysql2/promise";
import * as os from "os";
import * as readline from "readline";

/** Metadata the master keeps (in Redis) about each replica that requests replication. */
interface ReplicaRecord {
   ip: string;
   userAgent: string | null;
   requestCount: number;
   firstSeenAt: number; // epoch ms
   lastSeenAt: number; // epoch ms
}

@Injectable()
export class ReplicationService implements OnModuleInit {
   private readonly logger = new Logger(ReplicationService.name);
   private isReplicating = false; // lock flag
   private isDbReplicating = false; // lock flag for database replication

   // Redis hash key: field = replica IP, value = JSON(ReplicaRecord)
   private static readonly REPLICAS_KEY = "replication:replicas";

   constructor(
      private readonly config: ConfigService<EnvVariables>,
      private readonly fs: AbstractFileSystem,
      @Inject(REDIS_CACHE) private readonly redis: Redis,
      private readonly email: EmailService,
   ) { }

   public onModuleInit() {
      void this.replicate();
   }

   @Cron(CronExpression.EVERY_MINUTE, { name: "replication:replicate" })
   public async replicate() {
      if (this.isReplicating) {
         this.logger.warn("A replication job is currently running. Skipping this Cron iteration");
         return;
      }

      this.isReplicating = true;
      try {
         if (this.isReplica()) {
            this.logger.log("Replicating data from master...");

            const masterUrl = this.config.get("this-service.replication.master-or-replica-ip", { infer: true });
            if (!masterUrl) {
               this.logger.error("Master IP is not set");
               return;
            }

            const protocol = masterUrl.includes("shadijiha.com") ? "https" : "http";
            const masterIp = `${protocol}://${masterUrl}`;
            const replicaFiles = await this.listCloudDir();

            const listAllResponse = await fetch(`${masterIp}/replication/listall`, {
               headers: {
                  "x-service-key": this.config.get("cross-service.secret", { infer: true }),
               }
            });

            if (!listAllResponse.ok) {
               this.logger.error(`Failed to fetch list of files from master, status: ${listAllResponse.status}, text: ${await listAllResponse.text()}`);
               return;
            }

            const masterFiles: typeof replicaFiles = await listAllResponse.json();

            // Files to replicate (excluding ignored patterns)
            const replicaDoesNotHave = masterFiles.filter(
               (e) => !replicaFiles.find((f) => this.pathEquals(f.path, e.path)) && !this.isIgnored(e.path),
            );
            this.logger.log(`${replicaDoesNotHave.length} Files to replicate`);

            const totalBytes = replicaDoesNotHave.reduce((sum, f) => sum + (f.size ?? 0), 0);
            let bytesReplicated = 0;
            let filesReplicated = 0;
            for (const file of replicaDoesNotHave) {
               if (!this.fs.existsSync(path.join(this.cloudDir, file.path))) {
                  this.fs.mkdirSync(path.join(this.cloudDir, path.dirname(file.path)), { recursive: true });
               }

               const response = await fetch(`${masterIp}/replication/getfile/${encodeURIComponent(file.path)}`, {
                  headers: {
                     "x-service-key": this.config.get("cross-service.secret", { infer: true }),
                  }
               });

               if (!response.ok) {
                  this.logger.error(`Failed to download file ${file.path}, status: ${response.status}, text: ${await response.text()}`);
                  continue;
               }
               const filePath = path.join(this.cloudDir, file.path);
               const dest = this.fs.createWriteStream(filePath);

               await this.decryptResponseStream(response, dest, file.size, path.basename(file.path));

               bytesReplicated += file.size ?? 0;
               this.logger.log(`Done ${filesReplicated + 1} of ${replicaDoesNotHave.length} (${path.basename(file.path)}) - ${this.humanSize(bytesReplicated)} / ${this.humanSize(totalBytes)}`);
               filesReplicated++;
            }

            // Files to delete (never delete ignored paths)
            const masterDoesNotHave = replicaFiles.filter(
               (e) => !masterFiles.find((f) => this.pathEquals(f.path, e.path)) && !this.isIgnored(e.path),
            );
            this.logger.log(`${masterDoesNotHave.length} Files to delete`);
            let filesDeleted = 0;
            for (const file of masterDoesNotHave) {
               this.fs.unlinkSync(path.join(this.cloudDir, file.path));
               filesDeleted++;

               this.logger.log(`Deleted ${filesDeleted} of ${masterDoesNotHave.length} (file: ${file.path})`);
            }
         } else if (this.isMaster()) {
            // No op
         } else {
            this.logger.error(`Replication role is unknown ${this.config.get("this-service.replication.role", { infer: true })}`);
         }
      } catch (error) {
         const e = error as Error;
         const fullMessage = `${this.config.get("this-service.replication.role", { infer: true })} encountered an exception: ${e.message}`;
         this.logger.error(fullMessage, e.stack);
      } finally {
         this.isReplicating = false;
      }
   }

   public async listCloudDir() {
      return this.listRecusively(this.cloudDir);
   }

   /**
    * Records (on the master) that a replica requested replication, storing basic
    * metadata and bumping its last-seen timestamp + request count in Redis. Also
    * logs the request. No-op unless this instance is the master.
    */
   public async recordReplicaRequest(ip: string, userAgent?: string) {
      if (!this.isMaster()) return;

      const now = Date.now();
      const existingRaw = await this.redis.hget(ReplicationService.REPLICAS_KEY, ip);
      const existing = existingRaw ? (JSON.parse(existingRaw) as ReplicaRecord) : null;

      const record: ReplicaRecord = {
         ip,
         userAgent: userAgent ?? existing?.userAgent ?? null,
         requestCount: (existing?.requestCount ?? 0) + 1,
         firstSeenAt: existing?.firstSeenAt ?? now,
         lastSeenAt: now,
      };
      await this.redis.hset(ReplicationService.REPLICAS_KEY, ip, JSON.stringify(record));

      this.logger.log(
         `Replication request from replica ${ip} (agent: ${userAgent ?? "unknown"}), ` +
         `request #${record.requestCount}, last seen ${new Date(now).toISOString()}`,
      );
   }

   /**
    * Master-only: any replica that has not requested replication in more than 24h
    * is emailed about ONCE (to shadosite@gmail.com) and then removed from the
    * Redis registry. Removal guarantees the alert fires only once per stale replica.
    */
   @Cron(CronExpression.EVERY_HOUR, { name: "replication:stale-replica-check" })
   public async checkStaleReplicas() {
      if (!this.isMaster()) return;

      const all = await this.redis.hgetall(ReplicationService.REPLICAS_KEY);
      const now = Date.now();
      const staleCutoffMs = 24 * 60 * 60 * 1000;

      for (const [ip, raw] of Object.entries(all)) {
         let record: ReplicaRecord;
         try {
            record = JSON.parse(raw) as ReplicaRecord;
         } catch {
            // Corrupt entry — drop it.
            await this.redis.hdel(ReplicationService.REPLICAS_KEY, ip);
            continue;
         }

         const idleMs = now - record.lastSeenAt;
         if (idleMs <= staleCutoffMs) continue;

         const hoursIdle = Math.floor(idleMs / 3_600_000);
         await this.email.sendEmail({
            to: "shadosite@gmail.com",
            subject: `Shado Cloud: replica ${ip} has stopped replicating`,
            text:
               `Replica ${ip} (agent: ${record.userAgent ?? "unknown"}) has not requested ` +
               `replication for ${hoursIdle} hours.\n\n` +
               `Last seen: ${new Date(record.lastSeenAt).toISOString()}\n` +
               `First seen: ${new Date(record.firstSeenAt).toISOString()}\n` +
               `Total replication requests recorded: ${record.requestCount}\n\n` +
               `It has been removed from the master's replica registry and will be re-added ` +
               `automatically the next time it requests replication.`,
         });
         await this.redis.hdel(ReplicationService.REPLICAS_KEY, ip);
         this.logger.warn(`Removed stale replica ${ip} (idle ${hoursIdle}h) after notifying shadosite@gmail.com`);
      }
   }

   /**
    * Master: generates a `mysqldump`-equivalent of ALL application databases (a full
    * standby of the box — the source of truth) and streams it encrypted to the replica.
    *
    * All non-system schemas are dumped, each prefixed with `CREATE DATABASE IF NOT
    * EXISTS` + `USE`, so the replica recreates every service's database. System schemas
    * (information_schema, mysql, performance_schema, sys) are skipped.
    *
    * Streaming & memory: rows are streamed from the mysql2 driver to a temp .sql file
    * (batched INSERTs, constant memory — no CLI, no whole-DB-in-RAM), then that file is
    * streamed through the cipher to the response using the same leading-IV + AES-256-CTR
    * scheme as file transfer. `DROP TABLE IF EXISTS` per table means each import is a
    * clean replace, never a duplicate.
    */
   public async getDatabaseDump(res: Response) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", 'attachment; filename="db-dump.sql.enc"');

      const { host, port, user, password } = this.dbConfig;
      const tmpFile = path.join(os.tmpdir(), `shado-db-dump-${Date.now()}.sql`);
      const cleanup = () => {
         try {
            if (this.fs.existsSync(tmpFile)) this.fs.unlinkSync(tmpFile);
         } catch { /* best-effort */ }
      };

      // 1) Generate the dump to a temp file, streaming rows (bounded memory).
      // Connect without a default database so we can enumerate/read every schema.
      const conn = await createConnection({ host, port, user, password: password ?? "", maxAllowedPacket: 256 * 1024 * 1024 });
      try {
         await this.writeDumpToFile(conn, tmpFile);
      } catch (e) {
         this.logger.error(`Database dump generation failed: ${(e as Error).message}`);
         cleanup();
         if (!res.headersSent) res.status(500);
         res.end();
         return;
      } finally {
         await conn.end().catch(() => undefined);
      }

      // 2) Stream the temp file encrypted to the replica.
      const iv = randomBytes(16);
      const cipher = createCipheriv("aes-256-ctr", this.encryptionKey, iv);
      res.write(iv);
      const fileStream = this.fs.createReadStream(tmpFile);
      fileStream.pipe(cipher).pipe(res);

      res.on("finish", () => {
         this.logger.log("Streamed encrypted database dump (all databases)");
         cleanup();
      });
      res.on("close", cleanup);
      fileStream.on("error", (err) => {
         this.logger.error(`Database dump read error: ${err.message}`);
         res.end();
         cleanup();
      });
      cipher.on("error", () => {
         res.end();
         cleanup();
      });
   }

   // Schemas that must never be replicated (server-internal; overwriting `mysql`
   // would clobber the replica's own users/grants).
   private static readonly SYSTEM_SCHEMAS = new Set(["information_schema", "mysql", "performance_schema", "sys"]);

   // Max byte size of a single multi-row INSERT statement. Kept well under MySQL's
   // default max_allowed_packet (64MB) so imports never exceed the server limit.
   private static readonly MAX_INSERT_BYTES = 4 * 1024 * 1024;

   /**
    * Streams ALL application databases to `tmpFile` as SQL. Each database is emitted
    * with `CREATE DATABASE IF NOT EXISTS` + `USE`, then its tables (DROP + CREATE +
    * batched INSERTs). Each statement is written on a single line terminated by "\n"
    * (CREATE statements are flattened, and mysql2 escapes any newlines inside values),
    * so the replica can import it by splitting on lines.
    */
   private async writeDumpToFile(conn: Awaited<ReturnType<typeof createConnection>>, tmpFile: string) {
      const out = this.fs.createWriteStream(tmpFile);
      const write = (s: string) =>
         new Promise<void>((resolve, reject) => {
            const ok = out.write(s, (err) => {
               if (err) reject(err);
            });
            if (ok) resolve();
            else out.once("drain", resolve);
         });

      await write("SET FOREIGN_KEY_CHECKS=0;\n");

      const [databases] = await conn.query("SHOW DATABASES");
      for (const dbRow of databases as Record<string, string>[]) {
         const database = Object.values(dbRow)[0];
         if (ReplicationService.SYSTEM_SCHEMAS.has(database.toLowerCase())) continue;

         this.logger.log(`Dumping database "${database}"...`);
         await write(`CREATE DATABASE IF NOT EXISTS ${conn.escapeId(database)};\n`);
         await write(`USE ${conn.escapeId(database)};\n`);

         const [tables] = await conn.query(`SHOW FULL TABLES FROM ${conn.escapeId(database)} WHERE Table_type = 'BASE TABLE'`);
         for (const tableRow of tables as Record<string, string>[]) {
            const table = Object.values(tableRow)[0];

            const [createRows] = await conn.query(`SHOW CREATE TABLE ${conn.escapeId(database)}.${conn.escapeId(table)}`);
            const createSql = ((createRows as Record<string, string>[])[0]["Create Table"]).replace(/\r?\n/g, " ");
            await write(`DROP TABLE IF EXISTS ${conn.escapeId(table)};\n`);
            await write(`${createSql};\n`);

            // Stream rows so we never hold the whole table in memory. Batches are
            // bounded by BYTE size (not just row count) so no single INSERT exceeds
            // the server's max_allowed_packet.
            const rowStream = (conn as any).connection.query(`SELECT * FROM ${conn.escapeId(database)}.${conn.escapeId(table)}`).stream();
            let columns: string[] | null = null;
            let batch: string[] = [];
            let batchBytes = 0;
            let rowCount = 0;
            const flushBatch = async () => {
               if (batch.length === 0) return;
               const cols = columns!.map((c) => conn.escapeId(c)).join(",");
               await write(`INSERT INTO ${conn.escapeId(table)} (${cols}) VALUES ${batch.join(",")};\n`);
               batch = [];
               batchBytes = 0;
            };
            for await (const row of rowStream as AsyncIterable<Record<string, unknown>>) {
               if (!columns) columns = Object.keys(row);
               const tuple = `(${columns.map((c) => conn.escape(row[c])).join(",")})`;
               // Flush before adding if this row would push the statement over a safe
               // packet size, or the row-count cap is hit.
               if (batch.length > 0 && (batchBytes + tuple.length + 1 > ReplicationService.MAX_INSERT_BYTES || batch.length >= 500)) {
                  await flushBatch();
               }
               batch.push(tuple);
               batchBytes += tuple.length + 1;
               rowCount++;
            }
            await flushBatch();
            this.logger.log(`  dumped ${database}.${table} (${rowCount} rows)`);
         }
      }

      await write("SET FOREIGN_KEY_CHECKS=1;\n");
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
   }

   /**
    * Replica: fetches the master's encrypted DB dump, decrypts it to a temp file
    * (streamed, bounded memory — reuses the file decryptor), then imports it into the
    * replica's OWN database by executing it statement-by-statement over the mysql2
    * driver (no `mysql` CLI needed). Master is the source of truth.
    *
    * Runs hourly (separate from the per-minute file sync — a full dump/restore is
    * expensive). Adjust the Cron expression to change frequency.
    */
   @Cron(CronExpression.EVERY_HOUR, { name: "replication:replicate-database" })
   public async replicateDatabase() {
      if (!this.isReplica()) return;
      if (this.isDbReplicating) {
         this.logger.warn("A database replication job is already running. Skipping this iteration");
         return;
      }
      this.isDbReplicating = true;

      const tmpFile = path.join(os.tmpdir(), `shado-db-replica-${Date.now()}.sql`);
      let connection: Awaited<ReturnType<typeof createConnection>> | null = null;
      try {
         const masterUrl = this.config.get("this-service.replication.master-or-replica-ip", { infer: true });
         if (!masterUrl) {
            this.logger.error("Master IP is not set");
            return;
         }
         const protocol = masterUrl.includes("shadijiha.com") ? "https" : "http";
         const masterIp = `${protocol}://${masterUrl}`;

         this.logger.log("Replicating database from master...");
         const response = await fetch(`${masterIp}/replication/database`, {
            headers: { "x-service-key": this.config.get("cross-service.secret", { infer: true }) },
         });
         if (!response.ok) {
            this.logger.error(`Failed to fetch database dump, status: ${response.status}, text: ${await response.text()}`);
            return;
         }

         // Decrypt to a temp file (streamed, bounded memory).
         const dest = this.fs.createWriteStream(tmpFile);
         await this.decryptResponseStream(response, dest, undefined, "database dump");

         // Import statement-by-statement into the replica's server. No default database
         // is selected — the dump carries CREATE DATABASE / USE statements for every
         // service's schema (full-box standby).
         const { host, port, user, password } = this.dbConfig;
         connection = await createConnection({ host, port, user, password: password ?? "", maxAllowedPacket: 256 * 1024 * 1024 });

         const totalBytes = this.fs.existsSync(tmpFile) ? this.fs.statSync(tmpFile).size : 0;
         const rl = readline.createInterface({ input: this.fs.createReadStream(tmpFile), crlfDelay: Infinity });
         let statements = 0;
         let bytesProcessed = 0;
         let lastLoggedPct = 0;
         let currentDb = "";
         for await (const line of rl) {
            bytesProcessed += Buffer.byteLength(line) + 1; // +1 for the stripped newline
            const stmt = line.trim();
            if (!stmt) continue;

            const useMatch = /^USE\s+`?([^`;\s]+)`?;?$/i.exec(stmt);
            if (useMatch) {
               currentDb = useMatch[1];
               this.logger.log(`Importing database "${currentDb}"...`);
            }

            await connection.query(stmt);
            statements++;

            if (totalBytes > 0) {
               const pct = Math.floor((bytesProcessed / totalBytes) * 100);
               if (pct >= lastLoggedPct + 10) {
                  lastLoggedPct = pct - (pct % 10);
                  this.logger.log(
                     `Importing database dump: ${pct}% (${this.humanSize(bytesProcessed)} / ${this.humanSize(totalBytes)}, ${statements} statements)`,
                  );
               }
            }
         }
         this.logger.log(`Database replicated from master (all databases, ${statements} statements)`);
      } catch (error) {
         const e = error as Error;
         this.logger.error(`Database replication failed: ${e.message}`, e.stack);
      } finally {
         if (connection) {
            try {
               await connection.end();
            } catch { /* best-effort close */ }
         }
         try {
            if (this.fs.existsSync(tmpFile)) this.fs.unlinkSync(tmpFile);
         } catch { /* best-effort temp cleanup */ }
         this.isDbReplicating = false;
      }
   }

   private get dbConfig() {
      return {
         host: this.config.get("db.host", { infer: true }) || "localhost",
         port: this.config.get("db.port", { infer: true }) ?? 3306,
         user: this.config.get("db.username", { infer: true }),
         password: this.config.get("db.password", { infer: true }),
         database: this.config.get("db.name", { infer: true }),
      };
   }

   public async getFile(path_: string, res: Response) {
      // 1. Set explicit streaming headers
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(path_)}.enc"`);


      // 2. Generate a random 16-byte IV for this specific stream (AES-CTR uses a 16-byte IV)
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-ctr', this.encryptionKey, iv);

      // 3. Send the raw IV to the client first so they can decrypt it later
      res.write(iv);

      // 5. Create source stream and pipe: Source -> Encryption -> HTTP Response
      const fileStream = this.fs.createReadStream(path.join(this.cloudDir, path_));

      let plainBytes = 0;
      let encryptedBytes = 0;
      fileStream.on('data', (c) => (plainBytes += c.length));
      cipher.on('data', (c) => (encryptedBytes += c.length));
      res.on('finish', () => {
         this.logger.log(
            `Encrypted ${path.basename(path_)} - ${this.humanSize(plainBytes)} plaintext -> ${this.humanSize(encryptedBytes)} ciphertext ` +
            `(iv ${iv.toString("hex")}, key ${this.keyFingerprint})`,
         );
      });

      fileStream.pipe(cipher).pipe(res);

      // 6. Handle errors cleanly to prevent memory leaks or hanging connections
      fileStream.on('error', (err) => {
         this.logger.error(`File system read error while streaming ${path_}: ${err.message}`);
         if (!res.headersSent) {
            res.status(500).send('File system read error.');
         }
         res.end();
      });

      cipher.on('error', (err) => {
         this.logger.error(`Encryption error while streaming ${path_}: ${err.message}`);
         res.end();
      });
   }

   /************* Decryption functions ************/
   async decryptResponseStream(fetchResponse: globalThis.Response, outputStream: NodeJS.WritableStream, expectedSize?: number, label = "file") {
      const webStream = fetchResponse.body as any;
      const res = Readable.fromWeb(webStream);

      const key = this.encryptionKey;

      return new Promise<void>((resolve, reject) => {
         let decipher: ReturnType<typeof createDecipheriv> | null = null;
         let ivBuffer = Buffer.alloc(0);
         let decryptedBytes = 0;

         // Resolve/reject only once the output has been fully flushed to disk
         outputStream.on('finish', () => {
            if (expectedSize !== undefined && decryptedBytes !== expectedSize) {
               this.logger.warn(
                  `Decrypted ${label} size mismatch: got ${this.humanSize(decryptedBytes)}, expected ${this.humanSize(expectedSize)}`,
               );
            }
            resolve();
         });
         outputStream.on('error', (err) => reject(err));

         // Process the incoming network chunks
         res.on('data', (chunk: Buffer) => {
            // Extract the 16-byte IV from the absolute beginning of the stream
            if (ivBuffer.length < 16) {
               const bytesNeeded = 16 - ivBuffer.length;

               // Pull only what is needed for the IV out of this chunk
               const ivSegment = chunk.slice(0, bytesNeeded);
               ivBuffer = Buffer.concat([ivBuffer, ivSegment]);

               // Keep the rest of the chunk as the encrypted file content
               chunk = chunk.slice(bytesNeeded);

               // Once we have exactly 16 bytes, spin up the decipher engine
               if (ivBuffer.length === 16) {
                  decipher = createDecipheriv('aes-256-ctr', key, ivBuffer);
                  decipher.on('data', (c: Buffer) => (decryptedBytes += c.length));
                  decipher.on('error', (err) => reject(err));

                  // Directly pipe the decipher output to local disk storage
                  decipher.pipe(outputStream);
               }
            }

            // Pass all subsequent ciphertext data directly to the active decipher
            if (decipher && chunk.length > 0) {
               decipher.write(chunk);
            }
         });

         // Close the streams properly when the network transfer completes
         res.on('end', () => {
            if (decipher) {
               decipher.end();
            } else {
               // Stream ended before a full IV was received (e.g. empty file)
               outputStream.end();
            }
         });

         res.on('error', (err) => {
            this.logger.error(`Network stream error during decryption: ${err.message}`);
            outputStream.end();
            reject(err);
         });
      });
   }

   /**
    * Derives a deterministic 32-byte key for AES-256 from the configured salt.
    * AES-256 requires an exactly 32-byte key; the raw salt string is an arbitrary
    * length, so hashing it with SHA-256 guarantees a valid key length.
    */
   private get encryptionKey(): Buffer {
      const salt = this.config.get("this-service.password-vault-salt", { infer: true });
      return createHash("sha256").update(salt).digest();
   }

   /**
    * A short, non-sensitive identifier for the active key so logs on master and
    * replica can be compared without ever exposing the key itself.
    */
   private get keyFingerprint(): string {
      return createHash("sha256").update(this.encryptionKey).digest("hex").slice(0, 12);
   }

   private async listRecusively(path_: string) {
      const entries = this.fs.readdirSync(path_);

      // Get files within the current directory and add a path key to the file objects
      const files = entries
         .filter((file) => !file.isDirectory())
         .map((file) => ({ ...file, path: path.relative(this.config.get("this-service.cloud-dir", { infer: true }), path_ + "/" + file.name), size: this.fs.statSync(path_ + "/" + file.name).size }));

      // Get folders within the current directory
      const folders = entries.filter((folder) => folder.isDirectory());

      /*
       * Add the found files within the subdirectory to the files array by calling the
       * current function itself
       */
      for (const folder of folders) {
         files.push(...(await this.listRecusively(path.join(path_, folder.name))));
      }
      return files;
   }

   private isMaster() {
      return this.config.get("this-service.replication.role", { infer: true }) == ReplicationRole.Master ||
         this.config.get("this-service.replication.role", { infer: true }) == ReplicationRole.Primary;
   }

   private isReplica() {
      return this.config.get("this-service.replication.role", { infer: true }) == ReplicationRole.Replica;
   }

   private humanSize(bytes: number) {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let i = 0;
      while (bytes >= 1024 && i < units.length - 1) {
         bytes /= 1024;
         i++;
      }
      return `${bytes.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
   }

   /**
    * Returns true if the given cloud-relative path matches any configured
    * replica ignore glob pattern. Uses minimatch semantics; `dot: true` so
    * patterns also match dotfiles/dot-directories.
    */
   private isIgnored(relativePath: string): boolean {
      const patterns = this.config.get("this-service.replication.ignore-patterns", { infer: true });
      if (!patterns || patterns.length === 0) {
         return false;
      }

      // Normalize to forward slashes so patterns behave the same on any OS
      const normalized = relativePath.split(path.sep).join("/");
      return patterns.some((pattern) => minimatch(normalized, pattern, { dot: true }));
   }

   private pathEquals(path1: string, path2: string) {
      const normalizedPath1 = path.normalize(path.resolve(path1));
      const normalizedPath2 = path.normalize(path.resolve(path2));
      return normalizedPath1 == normalizedPath2;
   }

   private get cloudDir() {
      return this.config.get("this-service.cloud-dir", { infer: true });
   }
}
