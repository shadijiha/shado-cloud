import { Test, TestingModule } from "@nestjs/testing";
import { AdminGuard } from "src/admin/admin.strategy";
import { getRepositoryToken } from "@nestjs/typeorm";
import { User } from "src/models/user";
import { Repository } from "typeorm";
import { ExecutionContext, Request } from "@nestjs/common";
import { parseJwt } from "src/util";
import { CookiePayload } from "src/auth/authApiTypes";

// Mocking the utility function parseJwt
jest.mock("src/util", () => ({
    parseJwt: jest.fn(),
}));

describe("AdminGuard", () => {
    let guard: AdminGuard;
    let userRepo: Repository<User>;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AdminGuard,
                {
                    provide: getRepositoryToken(User),
                    useClass: Repository, // Mock Repository
                },
            ],
        }).compile();

        guard = module.get<AdminGuard>(AdminGuard);
        userRepo = module.get<Repository<User>>(getRepositoryToken(User));
    });

    it("should be defined", () => {
        expect(guard).toBeDefined();
    });

    describe("canActivate", () => {
        let context: ExecutionContext;

        beforeEach(() => {
            // Properly mock switchToHttp and getRequest
            context = {
                switchToHttp: jest.fn().mockReturnValue({
                    getRequest: jest.fn(), // Ensure getRequest is available on the returned object
                }),
            } as unknown as ExecutionContext;
        });

        it("should return true if user is an admin", async () => {
            const mockRequest = {
                cookies: {
                    [process.env.COOKIE_NAME]: "mock-jwt-token",
                },
            } as unknown as Request;

            const mockPayload: CookiePayload = { userId: 1 };
            const mockUser = { id: 1, is_admin: true };

            (parseJwt as jest.Mock).mockReturnValue(mockPayload);
            userRepo.findOne = jest.fn().mockResolvedValue(mockUser);

            // Mock the getRequest method to return the mockRequest
            (context.switchToHttp().getRequest as any).mockReturnValue(mockRequest);

            const result = await guard.canActivate(context);

            expect(result).toBe(true);
            expect(userRepo.findOne).toHaveBeenCalledWith({ where: { id: mockPayload.userId } });
        });

        it("should return false if user is not an admin", async () => {
            const mockRequest = {
                cookies: {
                    [process.env.COOKIE_NAME]: "mock-jwt-token",
                },
            } as unknown as Request;

            const mockPayload: CookiePayload = { userId: 2 };
            const mockUser = { id: 2, is_admin: false };

            (parseJwt as jest.Mock).mockReturnValue(mockPayload);
            userRepo.findOne = jest.fn().mockResolvedValue(mockUser);

            // Mock the getRequest method to return the mockRequest
            (context.switchToHttp().getRequest as any).mockReturnValue(mockRequest);

            const result = await guard.canActivate(context);

            expect(result).toBe(false);
            expect(userRepo.findOne).toHaveBeenCalledWith({ where: { id: mockPayload.userId } });
        });

        it("should return false if user is not found in the database", async () => {
            const mockRequest = {
                cookies: {
                    [process.env.COOKIE_NAME]: "mock-jwt-token",
                },
            } as unknown as Request;

            const mockPayload: CookiePayload = { userId: 3 };

            (parseJwt as jest.Mock).mockReturnValue(mockPayload);
            userRepo.findOne = jest.fn().mockResolvedValue(null);

            // Mock the getRequest method to return the mockRequest
            (context.switchToHttp().getRequest as any).mockReturnValue(mockRequest);

            const result = await guard.canActivate(context);

            expect(result).toBe(false);
            expect(userRepo.findOne).toHaveBeenCalledWith({ where: { id: mockPayload.userId } });
        });

        it("should return false if JWT is invalid or missing", async () => {
            const mockRequest = {
                cookies: {},
            } as unknown as Request;

            (parseJwt as jest.Mock).mockReturnValue(null); // simulating invalid JWT

            // Mock the getRequest method to return the mockRequest
            (context.switchToHttp().getRequest as any).mockReturnValue(mockRequest);

            const result = await guard.canActivate(context);

            expect(result).toBe(false);
        });
    });
});
