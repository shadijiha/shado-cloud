import { Logger as NestLogger } from "@nestjs/common";
import { Logger as TypeOrmLogger } from "typeorm";

/**
 * Custom TypeORM logger that counts queries and tracks total execution time.
 */
export class MetricsTypeOrmLogger implements TypeOrmLogger {
   private readonly logger = new NestLogger("TypeORM");

   public dbQueries = 0;
   public totalQueryTimeMs = 0;

   logQuery(_query: string, _parameters?: any[], _queryRunner?: any) {
      this.dbQueries++;
   }

   /** Called for every query when maxQueryExecutionTime is 0 */
   logQuerySlow(time: number) {
      this.totalQueryTimeMs += time;
   }

   logQueryError(error: string | Error) {
      this.logger.error(typeof error === "string" ? error : error.message);
   }

   logSchemaBuild() {}
   logMigration() {}

   log(level: "log" | "info" | "warn", message: any) {
      if (level === "warn") this.logger.warn(message);
   }
}

/** Singleton instance shared between app.module and metrics-pusher */
export const metricsTypeOrmLogger = new MetricsTypeOrmLogger();
