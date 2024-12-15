import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from 'src/auth/auth.controller';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from 'src/auth/auth.service';
import { DirectoriesService } from 'src/directories/directories.service';
import { FilesService } from 'src/files/files.service';
import { LoggerToDb } from 'src/logging';
import { Response } from "express";
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from 'src/models/user';
import { AuthGuard } from '@nestjs/passport';
import { IncomingHttpHeaders } from 'http';

jest.mock('argon2'); // Mock argon2 (password hashing)
jest.mock('sharp', () => {
    return jest.fn().mockImplementation(() => {
        return {
            resize: jest.fn().mockReturnThis(),
            toBuffer: jest.fn().mockResolvedValue(Buffer.from('mocked image data')),
            // Add other methods as necessary
        };
    });
});

describe('AuthController', () => {
    let authController: AuthController;
    let authService: AuthService;
    let directoriesService: DirectoriesService;
    let filesService: FilesService;
    let jwtService: JwtService;
    let logger: LoggerToDb;
    let response: Response;

    beforeEach(async () => {
        const mockJwtService = { sign: jest.fn().mockReturnValue('mocked-jwt-token') };
        const mockAuthService = {
            getByEmail: jest.fn(),
            passwordMatch: jest.fn(),
            new: jest.fn(),
            getById: jest.fn(),
        };
        const mockDirectoriesService = { createNewUserDir: jest.fn() };
        const mockFilesService = { profilePictureInfo: jest.fn().mockResolvedValue('mocked-prof-pic') };
        const mockLoggerToDb = { logException: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [AuthController],
            providers: [
                { provide: JwtService, useValue: mockJwtService },
                { provide: AuthService, useValue: mockAuthService },
                { provide: DirectoriesService, useValue: mockDirectoriesService },
                { provide: FilesService, useValue: mockFilesService },
                { provide: LoggerToDb, useValue: mockLoggerToDb },
            ],
        }).compile();

        authController = module.get<AuthController>(AuthController);
        authService = module.get<AuthService>(AuthService);
        directoriesService = module.get<DirectoriesService>(DirectoriesService);
        filesService = module.get<FilesService>(FilesService);
        jwtService = module.get<JwtService>(JwtService);
        logger = module.get<LoggerToDb>(LoggerToDb);

        // Mock response object
        response = {
            send: jest.fn(),
            cookie: jest.fn().mockReturnThis(),
            clearCookie: jest.fn().mockReturnThis()
        } as any;
    });

    it('should be defined', () => {
        expect(authController).toBeDefined();
    });

    describe('login', () => {
        it('should login successfully and return a JWT token', async () => {
            let cookieWasSet = false;
            const responseOverride = {
                send: jest.fn(),
                cookie: jest.fn().mockImplementation((cookieName, cookieValue, cookieOptions) => {
                    cookieWasSet = true;
                    return response;
                }),
                clearCookie: jest.fn().mockReturnThis()
            } as any;

            const body = { email: 'test@example.com', password: 'password123' };
            const mockUser = { id: 1, email: body.email, password: 'hashedPassword' };

            // Mock the AuthService methods
            authService.getByEmail = jest.fn().mockResolvedValue(mockUser);
            authService.passwordMatch = jest.fn().mockResolvedValue(true);

            // Mock file service
            filesService.profilePictureInfo = jest.fn().mockResolvedValue('mocked-prof-pic');

            const headers = { host: "localhost", origin: "http//localhost.test" } as IncomingHttpHeaders;
            await authController.login(headers, body, responseOverride);

            expect(authService.getByEmail).toHaveBeenCalledWith(body.email);
            expect(authService.passwordMatch).toHaveBeenCalledWith(mockUser.id, body.password);
            expect(jwtService.sign).toHaveBeenCalled();
            expect(responseOverride.cookie).toHaveBeenCalledWith(
                process.env.COOKIE_NAME,
                'mocked-jwt-token',
                expect.any(Object)
            );
            expect(cookieWasSet).toBeTruthy();
        });

        it('should return an error if the email is invalid', async () => {
            const body = { email: 'invalid@example.com', password: 'password123' };

            // Mock the AuthService methods
            authService.getByEmail = jest.fn().mockResolvedValue(null);

            const headers = { host: "localhost", origin: "http//localhost.test" } as IncomingHttpHeaders;
            await authController.login(headers, body, response);

            expect(response.send).toHaveBeenCalledWith({
                user: null,
                errors: [{ field: 'email', message: 'Invalid email' }],
            });
        });

        it('should return an error if the password is invalid', async () => {
            const body = { email: 'test@example.com', password: 'wrongPassword' };
            const mockUser = { id: 1, email: body.email, password: 'hashedPassword' };

            authService.getByEmail = jest.fn().mockResolvedValue(mockUser);
            authService.passwordMatch = jest.fn().mockResolvedValue(false);

            const headers = { host: "localhost", origin: "http//localhost.test" } as IncomingHttpHeaders;
            await authController.login(headers, body, response);

            expect(response.send).toHaveBeenCalledWith({
                user: null,
                errors: [{ field: 'password', message: 'Invalid credentials' }],
            });
        });
    });

    describe('register', () => {
        it('should register a user successfully', async () => {
            let cookieWasSet = false;
            const response = {
                send: jest.fn(),
                cookie: jest.fn().mockImplementation(() => {
                    cookieWasSet = true;
                    return response;
                }),
                clearCookie: jest.fn().mockReturnThis()
            } as any;

            const body = { name: 'New User', email: 'new@example.com', password: 'password123' };
            const mockUser = { id: 1, email: body.email, name: body.name, password: 'hashedPassword' };

            authService.getByEmail = jest.fn().mockResolvedValue(null);
            authService.new = jest.fn().mockResolvedValue(mockUser);
            directoriesService.createNewUserDir = jest.fn().mockResolvedValue(undefined);
            filesService.profilePictureInfo = jest.fn().mockResolvedValue('mocked-prof-pic');

            const headers = { host: "localhost", origin: "http//localhost.test" } as IncomingHttpHeaders;
            await authController.register(headers, body, response);

            expect(authService.getByEmail).toHaveBeenCalledWith(body.email);
            expect(authService.new).toHaveBeenCalledWith(body.name, body.email, body.password);
            expect(directoriesService.createNewUserDir).toHaveBeenCalledWith(mockUser);
            expect(response.cookie).toHaveBeenCalledWith(
                process.env.COOKIE_NAME,
                'mocked-jwt-token',
                expect.any(Object)
            );
            expect(cookieWasSet).toBeTruthy();
        });

        it('should return an error if the email is already taken', async () => {
            const body = { name: 'Existing User', email: 'taken@example.com', password: 'password123' };
            const mockUser = { id: 1, email: body.email, name: body.name, password: 'hashedPassword' };

            authService.getByEmail = jest.fn().mockResolvedValue(mockUser);

            const headers = { host: "localhost", origin: "http//localhost.test" } as IncomingHttpHeaders;
            await authController.register(headers, body, response);

            expect(response.send).toHaveBeenCalledWith({
                user: null,
                errors: [{ field: 'email', message: 'email is taken' }],
            });
        });
    });

    describe('logout', () => {
        it('should clear the cookie and send a response', async () => {
            const headers = { host: 'localhost' };
            await authController.logout(headers as any, response);

            expect(response.clearCookie).toHaveBeenCalledWith(process.env.COOKIE_NAME, {
                httpOnly: true,
                domain: 'localhost',
            });
            expect(response.send).toHaveBeenCalled();
        });
    });

    describe('me', () => {
        it('should return the authenticated user information', async () => {
            const userId = 1;
            const mockUser = { id: userId, name: 'Test User', email: 'test@example.com' };

            authService.getById = jest.fn().mockResolvedValue(mockUser);
            filesService.profilePictureInfo = jest.fn().mockResolvedValue('mocked-prof-pic');

            const result = await authController.me(userId, {} as any);

            expect(result).toEqual({ ...mockUser, profPic: 'mocked-prof-pic' });
            expect(authService.getById).toHaveBeenCalledWith(userId);
            expect(filesService.profilePictureInfo).toHaveBeenCalledWith(userId);
        });
    });
});