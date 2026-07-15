import { ConfigService } from "@nestjs/config";
import { CsrfMiddleware } from "src/csrf.middleware";
import { buildAllowedOrigins, isOriginAllowed } from "src/allowed-origins";

/**
 * Verifies the CSRF Origin/Referer allow-list logic and the service-to-service /
 * safe-method exemptions.
 */
describe("CsrfMiddleware (shado-cloud)", () => {
   const SECRET = "super-secret-service-key";
   const FRONTEND = "https://cloud.shadijiha.com,http://localhost:3000";

   function makeMiddleware(): CsrfMiddleware {
      const config = {
         get: (key: string) => {
            if (key === "this-service.frontend_url") return FRONTEND;
            if (key === "cross-service.secret") return SECRET;
            return undefined;
         },
      } as unknown as ConfigService<any>;
      return new CsrfMiddleware(config);
   }

   function run(headers: Record<string, string>, method = "POST") {
      const mw = makeMiddleware();
      const next = jest.fn();
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const req: any = { method, headers };
      const res: any = { status };
      mw.use(req, res, next);
      return { next, status, json };
   }

   it("skips safe methods (GET/HEAD/OPTIONS) regardless of origin", () => {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
         const { next, status } = run({ origin: "https://evil.example.com" }, method);
         expect(next).toHaveBeenCalledTimes(1);
         expect(status).not.toHaveBeenCalled();
      }
   });

   it("allows service-to-service calls with a valid x-service-key", () => {
      const { next, status } = run({ "x-service-key": SECRET, origin: "https://evil.example.com" });
      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
   });

   it("does NOT allow an invalid x-service-key from an untrusted origin", () => {
      const { next, status, json } = run({ "x-service-key": "wrong", origin: "https://evil.example.com" });
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalled();
   });

   it("allows a configured frontend origin", () => {
      const { next, status } = run({ origin: "https://cloud.shadijiha.com" });
      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
   });

   it("allows a wildcard shadijiha.com subdomain origin", () => {
      const { next, status } = run({ origin: "https://music.shadijiha.com" });
      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
   });

   it("allows capacitor:// and localhost origins (native apps)", () => {
      expect(run({ origin: "capacitor://localhost" }).next).toHaveBeenCalledTimes(1);
      expect(run({ origin: "http://localhost:5173" }).next).toHaveBeenCalledTimes(1);
      expect(run({ origin: "http://192.168.1.20:5100" }).next).toHaveBeenCalledTimes(1);
   });

   it("blocks a state-changing request from an untrusted origin with 403", () => {
      const { next, status, json } = run({ origin: "https://evil.example.com" });
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith(
         expect.objectContaining({ statusCode: 403, error: "Forbidden" }),
      );
   });

   it("falls back to the Referer origin when Origin header is absent", () => {
      expect(run({ referer: "https://cloud.shadijiha.com/some/path" }).next).toHaveBeenCalledTimes(1);
      const blocked = run({ referer: "https://evil.example.com/attack" });
      expect(blocked.next).not.toHaveBeenCalled();
      expect(blocked.status).toHaveBeenCalledWith(403);
   });

   it("allows non-browser requests with neither Origin nor Referer (e.g. webhooks, service-to-service)", () => {
      const { next, status } = run({});
      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
   });

   it("isOriginAllowed matches strings and regexes from buildAllowedOrigins", () => {
      const config = {
         get: (key: string) => (key === "this-service.frontend_url" ? FRONTEND : undefined),
      } as unknown as ConfigService<any>;
      const allowed = buildAllowedOrigins(config);
      expect(isOriginAllowed("http://localhost:3000", allowed)).toBe(true);
      expect(isOriginAllowed("capacitor://localhost", allowed)).toBe(true);
      expect(isOriginAllowed("https://evil.example.com", allowed)).toBe(false);
   });
});
