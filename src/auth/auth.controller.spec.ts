import { Test, TestingModule } from "@nestjs/testing";
import { AuthController } from "./auth.controller";
import { JwtService } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { DirectoriesService } from "../directories/directories.service";
import { FilesService } from "../files/files.service";
import { LoggerToDb } from "../logging";
import { ConfigService } from "@nestjs/config";

describe("AuthController", () => {
   let controller: AuthController;

   beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
         controllers: [AuthController],
         providers: [
            { provide: JwtService, useValue: { sign: jest.fn(), verify: jest.fn() } },
            { provide: AuthService, useValue: { getByEmail: jest.fn(), validatePassword: jest.fn() } },
            { provide: DirectoriesService, useValue: {} },
            { provide: FilesService, useValue: {} },
            { provide: LoggerToDb, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } },
            { provide: ConfigService, useValue: { get: jest.fn() } },
         ],
      }).compile();

      controller = module.get<AuthController>(AuthController);
   });

   it("should be defined", () => {
      expect(controller).toBeDefined();
   });
});
