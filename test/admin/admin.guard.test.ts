import { type ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AdminGuard } from "src/admin/admin.strategy";
import { User } from "src/models/user";

describe("AdminGuard", () => {
   let guard: AdminGuard;
   let userRepo: { findOne: jest.Mock };

   const createMockContext = (cookie: string | undefined): ExecutionContext => ({
      switchToHttp: () => ({
         getRequest: () => ({
            cookies: { test_cookie: cookie },
         }),
      }),
   }) as unknown as ExecutionContext;

   // Create a valid JWT payload (base64 encoded)
   const createJwt = (payload: object): string => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64");
      const body = Buffer.from(JSON.stringify(payload)).toString("base64");
      return `${header}.${body}.signature`;
   };

   beforeEach(async () => {
      userRepo = { findOne: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            AdminGuard,
            {
               provide: getRepositoryToken(User),
               useValue: userRepo,
            },
            {
               provide: ConfigService,
               useValue: {
                  get: jest.fn().mockReturnValue("test_cookie"),
               },
            },
         ],
      }).compile();

      guard = module.get<AdminGuard>(AdminGuard);
   });

   it("should return false when no cookie present", async () => {
      const ctx = createMockContext(undefined);
      const result = await guard.canActivate(ctx);
      expect(result).toBe(false);
   });

   it("should return false when JWT has no userId", async () => {
      const ctx = createMockContext(createJwt({ email: "test@test.com" }));
      const result = await guard.canActivate(ctx);
      expect(result).toBe(false);
   });

   it("should return false when user not found", async () => {
      userRepo.findOne.mockResolvedValue(null);
      const ctx = createMockContext(createJwt({ userId: 1 }));

      const result = await guard.canActivate(ctx);

      expect(result).toBe(false);
      expect(userRepo.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
   });

   it("should return false when user is not admin", async () => {
      userRepo.findOne.mockResolvedValue({ id: 1, is_admin: false });
      const ctx = createMockContext(createJwt({ userId: 1 }));

      const result = await guard.canActivate(ctx);

      expect(result).toBe(false);
   });

   it("should return true when user is admin", async () => {
      userRepo.findOne.mockResolvedValue({ id: 1, is_admin: true });
      const ctx = createMockContext(createJwt({ userId: 1 }));

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
   });
});
