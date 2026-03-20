import { Test, type TestingModule } from "@nestjs/testing";
import { AdminGuard } from "src/admin/admin.strategy";
import { AuthService } from "src/auth/auth.service";
import { type ExecutionContext } from "@nestjs/common";

describe("AdminGuard", () => {
   let guard: AdminGuard;
   let authService: { validateCookies: jest.Mock; isAdmin: jest.Mock; getUser: jest.Mock };

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

   function mockContext(cookie: string | undefined): ExecutionContext {
      return {
         switchToHttp: () => ({
            getRequest: () => ({ headers: { cookie } }),
         }),
      } as unknown as ExecutionContext;
   }

   it("should return true if user is admin", async () => {
      authService.validateCookies.mockResolvedValue("uuid-1");
      authService.getUser.mockResolvedValue({ id: 1 });
      authService.isAdmin.mockResolvedValue(true);

      const result = await guard.canActivate(mockContext("shado_auth=token"));
      expect(result).toBe(true);
   });

   it("should return false if user is not admin", async () => {
      authService.validateCookies.mockResolvedValue("uuid-2");
      authService.getUser.mockResolvedValue({ id: 2 });
      authService.isAdmin.mockResolvedValue(false);

      const result = await guard.canActivate(mockContext("shado_auth=token"));
      expect(result).toBe(false);
   });

   it("should return false if token is invalid", async () => {
      authService.validateCookies.mockResolvedValue(null);

      const result = await guard.canActivate(mockContext("shado_auth=bad"));
      expect(result).toBe(false);
   });

   it("should return false if no cookie", async () => {
      const result = await guard.canActivate(mockContext(undefined));
      expect(result).toBe(false);
   });
});
