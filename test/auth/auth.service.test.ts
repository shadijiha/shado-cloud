import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "src/auth/auth.service";
import { AUTH_SERVICE } from "src/auth/auth.constants";
import { REDIS_CACHE } from "src/util";
import { of } from "rxjs";
import { getRepositoryToken } from "@nestjs/typeorm";
import { User } from "src/models/user";
import { AuthTrafficService } from "src/auth/auth-traffic.service";

describe("AuthService", () => {
   let service: AuthService;
   let mockAuthClient: { send: jest.Mock };
   let mockCache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
   let mockUserRepo: { findOne: jest.Mock; save: jest.Mock };
   const serviceKey = "test-secret";

   beforeEach(async () => {
      mockAuthClient = { send: jest.fn() };
      mockCache = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() };
      mockUserRepo = { findOne: jest.fn(), save: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
         providers: [
            AuthService,
            AuthTrafficService,
            { provide: AUTH_SERVICE, useValue: mockAuthClient },
            { provide: REDIS_CACHE, useValue: mockCache },
            { provide: getRepositoryToken(User), useValue: mockUserRepo },
            { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(serviceKey) } },
         ],
      }).compile();

      service = module.get<AuthService>(AuthService);
   });

   it("should be defined", () => {
      expect(service).toBeDefined();
   });

   describe("validateCookies", () => {
      it("should return shadoUserId for valid cookies", async () => {
         mockAuthClient.send.mockReturnValue(of({ userId: "uuid-1" }));
         const result = await service.validateCookies("shado_auth=valid-token");
         expect(result).toBe("uuid-1");
         expect(mockAuthClient.send).toHaveBeenCalledWith("validate_cookie", { cookies: "shado_auth=valid-token", serviceKey });
      });

      it("should return null for invalid cookies", async () => {
         mockAuthClient.send.mockReturnValue(of({ userId: null }));
         const result = await service.validateCookies("shado_auth=bad-token");
         expect(result).toBeNull();
      });
   });

   describe("getUser", () => {
      it("should return cached user if available", async () => {
         const mockUser = { id: 1, shadoUserId: "uuid-1" };
         mockCache.get.mockResolvedValue(JSON.stringify(mockUser));

         const result = await service.getUser("uuid-1");
         expect(result).toEqual(mockUser);
         expect(mockAuthClient.send).not.toHaveBeenCalled();
      });

      it("should fetch from auth-api and create local user on miss", async () => {
         const remote = { id: "uuid-1", email: "test@example.com", name: "Test", is_admin: false };
         mockAuthClient.send.mockReturnValue(of(remote));
         mockUserRepo.findOne.mockResolvedValue(null);
         const saved = { id: 1, shadoUserId: "uuid-1" };
         mockUserRepo.save.mockResolvedValue(saved);

         const result = await service.getUser("uuid-1");
         expect(result).toEqual(saved);
         expect(mockAuthClient.send).toHaveBeenCalledWith("get_user", { userId: "uuid-1", serviceKey });
         expect(mockCache.set).toHaveBeenCalled();
      });
   });

   describe("getById", () => {
      it("should return local user by numeric id", async () => {
         const mockUser = { id: 1, shadoUserId: "uuid-1" };
         mockUserRepo.findOne.mockResolvedValue(mockUser);

         const result = await service.getById(1);
         expect(result).toEqual(mockUser);
      });
   });

   describe("isAdmin", () => {
      it("should return true for admin user", async () => {
         mockAuthClient.send.mockReturnValue(of(true));
         const result = await service.isAdmin("uuid-1");
         expect(result).toBe(true);
      });
   });
});
