import * as net from "net";

/**
 * Connects to the music microservice's raw TCP stream server.
 * Sends a JSON request line, receives a JSON header line, then raw binary follows on the socket.
 */
export function requestStream(
   host: string,
   port: number,
   req: { action: string; filePath: string; start?: number; end?: number },
): Promise<{ header: any; socket: net.Socket }> {
   return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
         socket.write(JSON.stringify(req) + "\n");
      });

      let buffer = "";
      const onData = (data: Buffer) => {
         buffer += data.toString("binary");
         const newlineIdx = buffer.indexOf("\n");
         if (newlineIdx === -1) return;

         socket.removeListener("data", onData);

         const headerStr = buffer.substring(0, newlineIdx);
         const remainingBinary = Buffer.from(buffer.substring(newlineIdx + 1), "binary");

         let header: any;
         try {
            header = JSON.parse(headerStr);
         } catch {
            reject(new Error("Invalid response header"));
            return;
         }

         if (remainingBinary.length > 0) {
            socket.unshift(remainingBinary);
         }

         resolve({ header, socket });
      };

      socket.on("data", onData);
      socket.on("error", reject);
   });
}
