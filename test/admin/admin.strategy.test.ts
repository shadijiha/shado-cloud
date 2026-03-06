import { AdminGuard } from "src/admin/admin.strategy";
import { type ExecutionContext } from "@nestjs/common";

describe("AdminGuard", () => {
   const guard = new AdminGuard();

   function mockContext(authUser: any): ExecutionContext {
      return {
         switchToHttp: () => ({
            getRequest: () => ({ authUser }),
         }),
      } as unknown as ExecutionContext;
   }

   it("should return true if user is admin", () => {
      expect(guard.canActivate(mockContext({ isAdmin: true }))).toBe(true);
   });

   it("should return false if user is not admin", () => {
      expect(guard.canActivate(mockContext({ isAdmin: false }))).toBe(false);
   });

   it("should return false if no authUser", () => {
      expect(guard.canActivate(mockContext(undefined))).toBe(false);
   });
});
