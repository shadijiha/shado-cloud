import { Test, type TestingModule } from "@nestjs/testing";
import { AdminGuard } from "src/admin/admin.strategy";
import { AuthService } from "src/auth/auth.service";
import { type ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

describe("AdminGuard", () => {
   let guard: AdminGuard;
   let authService: { validateToken: jest.Mock; isAdmin: jest.Mock; getUser: jest.Mock };

   beforeEach(async () => {
      authService = { validateToken: jest.fn(), isAdmin: jest.fn(), getUser: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            AdminGuard,
            { provide: AuthService, useValue: authService },
            {
               provide: ConfigService,
               useValue: { get: jest.fn().mockReturnValue("shado_cloud_prod") },
            },
         ],
      }).compile();

      guard = module.get<AdminGuard>(AdminGuard);
   });

   function mockContext(cookies: Record<string, string>): ExecutionContext {
      return {
         switchToHttp: () => ({
            getRequest: () => ({ cookies }),
         }),
      } as unknown as ExecutionContext;
   }

   it("should return true if user is admin", async () => {
      authService.validateToken.mockResolvedValue("uuid-1");
      authService.getUser.mockResolvedValue({ id: 1 });
      authService.isAdmin.mockResolvedValue(true);

      const result = await guard.canActivate(mockContext({ shado_cloud_prod: "token" }));
      expect(result).toBe(true);
   });

   it("should return false if user is not admin", async () => {
      authService.validateToken.mockResolvedValue("uuid-2");
      authService.getUser.mockResolvedValue({ id: 2 });
      authService.isAdmin.mockResolvedValue(false);

      const result = await guard.canActivate(mockContext({ shado_cloud_prod: "token" }));
      expect(result).toBe(false);
   });

   it("should return false if token is invalid", async () => {
      authService.validateToken.mockResolvedValue(null);

      const result = await guard.canActivate(mockContext({ shado_cloud_prod: "bad" }));
      expect(result).toBe(false);
   });

   it("should return false if no cookie", async () => {
      const result = await guard.canActivate(mockContext({}));
      expect(result).toBe(false);
   });
});
