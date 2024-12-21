import { Test, type TestingModule } from "@nestjs/testing";
import { type CookiePayload } from "src/auth/authApiTypes";
import { AuthStrategy } from "src/auth/auth.strategy";
import { JwtModule } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";

describe("AuthStrategy", () => {
   let stategy: AuthStrategy;

   beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
         imports: [
            JwtModule.register({
               secret: "test",
               signOptions: {
                  expiresIn: "24h",
               },
            }),
         ],
         providers: [
            AuthStrategy,
            {
               provide: ConfigService,
               useValue: {
                  get: jest.fn().mockImplementation((key: string) => {
                     if (key == "COOKIE_NAME") return "shado_cloud_prod";
                     else if (key == "JWT_SECRET") return "test";
                  }),
               },
            },
         ],
      }).compile();

      stategy = module.get<AuthStrategy>(AuthStrategy);
   });

   it("should be defined", () => {
      expect(stategy).toBeDefined();
   });

   describe("validate", () => {
      it("should always return true", async () => {
         const data: CookiePayload = {
            userId: 1,
         };

         const result = await stategy.validate(data);
         expect(result).toBe(true);
      });
   });
});
