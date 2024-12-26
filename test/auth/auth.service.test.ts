import { Test, type TestingModule } from "@nestjs/testing";
import { AuthService } from "src/auth/auth.service";
import { User } from "src/models/user";
import { type Repository } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import argon2 from "argon2";
import { REDIS_CACHE } from "src/util";
import { LoggerToDb } from "src/logging";

jest.mock("argon2");

describe("AuthService", () => {
   let service: AuthService;
   let userRepo: Repository<User>;

   beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
         providers: [
            AuthService,
            {
               provide: getRepositoryToken(User),
               useValue: {
                  findOne: jest.fn(),
                  save: jest.fn(),
                  createQueryBuilder: jest.fn(),
               },
            },
            {
               provide: REDIS_CACHE,
               useValue: {
                  get: jest.fn().mockReturnValue(null),
                  set: jest.fn(),
               },
            },
            {
               provide: LoggerToDb,
               useValue: {
                  warn: jest.fn(),
               },
            },
         ],
      }).compile();

      service = module.get<AuthService>(AuthService);
      userRepo = module.get<Repository<User>>(getRepositoryToken(User));
   });

   it("should be defined", () => {
      expect(service).toBeDefined();
   });

   describe("getByEmail", () => {
      it("should return a user by email", async () => {
         const email = "test@example.com";
         const mockUser = { id: 1, name: "Test User", email } as User;
         jest.spyOn(userRepo, "findOne").mockResolvedValue(mockUser);

         const result = await service.getByEmail(email);

         expect(result).toEqual(mockUser);
         expect(userRepo.findOne).toHaveBeenCalledWith({ where: { email } });
      });

      it("should return null if user is not found", async () => {
         const email = "nonexistent@example.com";
         jest.spyOn(userRepo, "findOne").mockResolvedValue(null);

         const result = await service.getByEmail(email);

         expect(result).toBeNull();
      });
   });

   describe("new", () => {
      it("should create and return a new user", async () => {
         const name = "New User";
         const email = "new@example.com";
         const password = "password123";
         const hashedPassword = "hashedPassword";

         // Mock argon2.hash to return a fake hash
         jest.spyOn(argon2, "hash").mockResolvedValue(hashedPassword);

         const mockUser = new User();
         mockUser.name = name;
         mockUser.email = email;
         mockUser.password = hashedPassword;

         jest.spyOn(userRepo, "save").mockResolvedValue(mockUser);

         const result = await service.new(name, email, password);

         expect(result).toEqual(mockUser);
         expect(userRepo.save).toHaveBeenCalledWith(mockUser);
         expect(argon2.hash).toHaveBeenCalledWith(password);
      });
   });

   describe("getById", () => {
      it("should return a user by id", async () => {
         const userId = 1;
         const mockUser = { id: userId, name: "Test User", email: "test@example.com" } as User;
         jest.spyOn(userRepo, "findOne").mockResolvedValue(mockUser);

         const result = await service.getById(userId);

         expect(result).toEqual(mockUser);
         expect(userRepo.findOne).toHaveBeenCalledWith({ where: { id: userId } });
      });

      it("should return null if user is not found", async () => {
         const userId = 1;
         jest.spyOn(userRepo, "findOne").mockResolvedValue(null);

         const result = await service.getById(userId);

         expect(result).toBeNull();
      });
   });

   describe("passwordMatch", () => {
      it("should return true if the password matches", async () => {
         const userId = 1;
         const password = "password123";
         const mockUser = { id: userId, password: "hashedPassword" };

         // Mock the repository and argon2.verify
         jest.spyOn(userRepo, "createQueryBuilder").mockReturnValue({
            select: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(mockUser),
         } as any);

         jest.spyOn(argon2, "verify").mockResolvedValue(true);

         const result = await service.passwordMatch(userId, password);

         expect(result).toBe(true);
         expect(argon2.verify).toHaveBeenCalledWith(mockUser.password, password);
      });

      it("should return false if the password does not match", async () => {
         const userId = 1;
         const password = "wrongPassword";
         const mockUser = { id: userId, password: "hashedPassword" };

         jest.spyOn(userRepo, "createQueryBuilder").mockReturnValue({
            select: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(mockUser),
         } as any);

         jest.spyOn(argon2, "verify").mockResolvedValue(false);

         const result = await service.passwordMatch(userId, password);

         expect(result).toBe(false);
      });
   });

   describe("getWithPassword", () => {
      it("should return a user with password", async () => {
         const userId = 1;
         const mockUser = { id: userId, name: "Test User", email: "test@example.com", password: "hashedPassword" };

         jest.spyOn(userRepo, "createQueryBuilder").mockReturnValue({
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(mockUser),
         } as any);

         const result = await service.getWithPassword(userId);

         expect(result).toEqual(mockUser);
         expect(userRepo.createQueryBuilder).toHaveBeenCalled();
         expect(result.password).toBeDefined();
      });
   });
});
