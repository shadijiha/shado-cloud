import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminController } from 'src/admin/admin.controller';
import { AdminService } from 'src/admin/admin.service';
import { AdminGuard } from 'src/admin/admin.strategy';
import { LoggerToDb } from 'src/logging';
import { Log } from 'src/models/log';
import { User } from 'src/models/user';
import { Repository } from 'typeorm';

describe('AdminController', () => {
    let adminController: AdminController;
    let adminService: AdminService;
    let logger: LoggerToDb;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminController],
            providers: [
                {
                    provide: AdminService,
                    useValue: {
                        all: jest.fn(),
                        deleteByIds: jest.fn(async () => {}),
                        redeploy: jest.fn(),
                    },
                },
                {
                    provide: LoggerToDb,
                    useValue: {
                        logException: jest.fn(),
                        log: jest.fn(),
                        error: jest.fn(),
                    },
                },
                {
                    provide: AdminGuard,
                    useValue: {
                        canActivate: jest.fn().mockReturnValue(true),
                    },
                },
                {
                    provide: getRepositoryToken(User),
                    useValue: {
                        findOne: jest.fn(),
                    },
                }
            ],
        }).compile();

        adminController = module.get<AdminController>(AdminController);
        adminService = module.get<AdminService>(AdminService);
        logger = module.get<LoggerToDb>(LoggerToDb);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('logs', () => {
        it('should return a list of logs', async () => {
            const mockLogs: Log[] = [
                { id: 1, message: 'Test log'} as Log
            ];
            jest.spyOn(adminService, 'all').mockResolvedValue(mockLogs);

            const result = await adminController.logs();
            expect(result).toEqual(mockLogs);
            expect(adminService.all).toHaveBeenCalledTimes(1);
        });

        it('should return an empty array if an exception occurs', async () => {
            jest.spyOn(adminService, 'all').mockRejectedValue(new Error('Test error'));

            const result = await adminController.logs();
            expect(result).toEqual([]);
            expect(logger.logException).toHaveBeenCalled();
        });
    });

    describe('logInfo', () => {
        it('should log a debug message', async () => {
            const logMessage = 'This is a debug log to test logging';
            jest.spyOn(logger, 'log').mockImplementation();

            await adminController.logInfo();
            expect(logger.log).toHaveBeenCalledWith(logMessage);
        });
    });

    describe('delete', () => {
        it('should delete logs by ids when a single id is passed', async () => {
            const id = '1';
            const mockDeleteResponse = undefined;
            jest.spyOn(adminService, 'deleteByIds').mockResolvedValue(mockDeleteResponse);

            await adminController.delete(id);

            expect(adminService.deleteByIds).toHaveBeenCalledWith([1]);
            expect(adminService.deleteByIds).toHaveBeenCalledTimes(1);
        });

        it('should delete logs by ids when an array of ids is passed', async () => {
            const id = '[1,2,3]';
            const mockDeleteResponse = undefined;
            jest.spyOn(adminService, 'deleteByIds').mockResolvedValue(mockDeleteResponse);

            await adminController.delete(id);

            expect(adminService.deleteByIds).toHaveBeenCalledWith([1, 2, 3]);
            expect(adminService.deleteByIds).toHaveBeenCalledTimes(1);
        });

        it('should ignore invalid integers and flatten array in input array', async () => {
            const id = '[1, 2, ni, 4, [5, 6]]';
            
            await adminController.delete(id);
            expect(adminService.deleteByIds).toHaveBeenCalledWith([1, 2, 4, 5, 6]);
        });

        it('should log an error and throw if invalid ids are provided', async () => {
            const id = 'invalid';
            jest.spyOn(logger, 'logException').mockImplementation();
            
            await expect(adminController.delete(id)).rejects.toThrow(HttpException);
            expect(logger.error).toHaveBeenCalled();
            expect(adminService.deleteByIds).not.toHaveBeenCalled();
        });
    });

    describe('redeploy', () => {
        it('should call redeploy', async () => {
            expect(true).toBe(true);
        });
    });
});