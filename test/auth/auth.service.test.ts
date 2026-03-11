import { Test, type TestingModule } from "@nestjs/testing";
import { AuthService } from "src/auth/auth.service";
import { AUTH_SERVICE } from "src/auth/auth.module";
import { REDIS_CACHE } from "src/util";
import { of } from "rxjs";

describe("AuthService", () => {
   let service: AuthService;
   let mockAuthClient: { send: jest.Mock };
   let mockCache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

   beforeEach(async () => {
      mockAuthClient = { send: jest.fn() };
      mockCache = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            AuthService,
            { provide: AUTH_SERVICE, useValue: mockAuthClient },
            { provide: REDIS_CACHE, useValue: mockCache },
         ],
      }).compile();

      service = module.get<AuthService>(AuthService);
   });

   it("should be defined", () => {
      expect(service).toBeDefined();
   });

   describe("validateToken", () => {
      it("should return userId for valid token", async () => {
         mockAuthClient.send.mockReturnValue(of({ userId: 1 }));
         const result = await service.validateToken("valid-token");
         expect(result).toBe(1);
         expect(mockAuthClient.send).toHaveBeenCalledWith("validate_token", { token: "valid-token" });
      });

      it("should return null for invalid token", async () => {
         mockAuthClient.send.mockReturnValue(of({ userId: null }));
         const result = await service.validateToken("bad-token");
         expect(result).toBeNull();
      });
   });

   describe("getById", () => {
      it("should return cached user if available", async () => {
         const mockUser = { id: 1, email: "test@example.com" };
         mockCache.get.mockResolvedValue(JSON.stringify(mockUser));

         const result = await service.getById(1);
         expect(result).toEqual(mockUser);
         expect(mockAuthClient.send).not.toHaveBeenCalled();
      });

      it("should fetch from auth service and cache on miss", async () => {
         const mockUser = { id: 1, email: "test@example.com" };
         mockAuthClient.send.mockReturnValue(of(mockUser));

         const result = await service.getById(1);
         expect(result).toEqual(mockUser);
         expect(mockAuthClient.send).toHaveBeenCalledWith("get_user", { userId: 1 });
         expect(mockCache.set).toHaveBeenCalled();
      });
   });

   describe("getWithPassword", () => {
      it("should call get_user_with_password", async () => {
         const mockUser = { id: 1, password: "hashed" };
         mockAuthClient.send.mockReturnValue(of(mockUser));

         const result = await service.getWithPassword(1);
         expect(result).toEqual(mockUser);
         expect(mockAuthClient.send).toHaveBeenCalledWith("get_user_with_password", { userId: 1 });
      });
   });

   describe("isAdmin", () => {
      it("should return true for admin user", async () => {
         mockAuthClient.send.mockReturnValue(of(true));
         const result = await service.isAdmin(1);
         expect(result).toBe(true);
      });
   });
});
