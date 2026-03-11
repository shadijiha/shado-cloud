import { type ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { AdminGuard } from "src/admin/admin.strategy";
import { AuthService } from "src/auth/auth.service";

describe("AdminGuard", () => {
   let guard: AdminGuard;
   let authService: { validateToken: jest.Mock; isAdmin: jest.Mock };

   const createMockContext = (cookie: string | undefined): ExecutionContext =>
      ({
         switchToHttp: () => ({
            getRequest: () => ({
               cookies: { test_cookie: cookie },
            }),
         }),
      }) as unknown as ExecutionContext;

   beforeEach(async () => {
      authService = { validateToken: jest.fn(), isAdmin: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            AdminGuard,
            { provide: AuthService, useValue: authService },
            {
               provide: ConfigService,
               useValue: { get: jest.fn().mockReturnValue("test_cookie") },
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

   it("should return false when token is invalid", async () => {
      authService.validateToken.mockResolvedValue(null);
      const ctx = createMockContext("bad-token");
      const result = await guard.canActivate(ctx);
      expect(result).toBe(false);
   });

   it("should return false when user is not admin", async () => {
      authService.validateToken.mockResolvedValue(1);
      authService.isAdmin.mockResolvedValue(false);
      const ctx = createMockContext("valid-token");
      const result = await guard.canActivate(ctx);
      expect(result).toBe(false);
   });

   it("should return true when user is admin", async () => {
      authService.validateToken.mockResolvedValue(1);
      authService.isAdmin.mockResolvedValue(true);
      const ctx = createMockContext("valid-token");
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
   });
});
