import { type ExecutionContext } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { AdminGuard } from "src/admin/admin.strategy";
import { AuthService } from "src/auth/auth.service";

describe("AdminGuard", () => {
   let guard: AdminGuard;
   let authService: { validateCookies: jest.Mock; isAdmin: jest.Mock; getUser: jest.Mock };

   const createMockContext = (cookie: string | undefined): ExecutionContext =>
      ({
         switchToHttp: () => ({
            getRequest: () => ({
               headers: { cookie },
            }),
         }),
      }) as unknown as ExecutionContext;

   beforeEach(async () => {
      authService = { validateCookies: jest.fn(), isAdmin: jest.fn(), getUser: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            AdminGuard,
            { provide: AuthService, useValue: authService },
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
      authService.validateCookies.mockResolvedValue(null);
      const ctx = createMockContext("shado_auth=bad-token");
      const result = await guard.canActivate(ctx);
      expect(result).toBe(false);
   });

   it("should return false when user not found locally", async () => {
      authService.validateCookies.mockResolvedValue("uuid-1");
      authService.getUser.mockResolvedValue(null);
      const ctx = createMockContext("shado_auth=valid-token");
      const result = await guard.canActivate(ctx);
      expect(result).toBe(false);
   });

   it("should return false when user is not admin", async () => {
      authService.validateCookies.mockResolvedValue("uuid-1");
      authService.getUser.mockResolvedValue({ id: 1 });
      authService.isAdmin.mockResolvedValue(false);
      const ctx = createMockContext("shado_auth=valid-token");
      const result = await guard.canActivate(ctx);
      expect(result).toBe(false);
   });

   it("should return true when user is admin", async () => {
      authService.validateCookies.mockResolvedValue("uuid-1");
      authService.getUser.mockResolvedValue({ id: 1 });
      authService.isAdmin.mockResolvedValue(true);
      const ctx = createMockContext("shado_auth=valid-token");
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
   });
});
