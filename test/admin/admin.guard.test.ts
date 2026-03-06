import { type ExecutionContext } from "@nestjs/common";
import { AdminGuard } from "src/admin/admin.strategy";

describe("AdminGuard", () => {
   const guard = new AdminGuard();

   const createCtx = (authUser: any): ExecutionContext =>
      ({ switchToHttp: () => ({ getRequest: () => ({ authUser }) }) }) as unknown as ExecutionContext;

   it("should return false when no authUser", () => {
      expect(guard.canActivate(createCtx(undefined))).toBe(false);
   });

   it("should return false when user is not admin", () => {
      expect(guard.canActivate(createCtx({ isAdmin: false }))).toBe(false);
   });

   it("should return true when user is admin", () => {
      expect(guard.canActivate(createCtx({ isAdmin: true }))).toBe(true);
   });
});
