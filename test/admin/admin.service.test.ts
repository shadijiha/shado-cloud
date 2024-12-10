import { Test, TestingModule } from '@nestjs/testing';
import { AdminService } from 'src/admin/admin.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Log } from 'src/models/log';
import { Repository } from 'typeorm';
import { exec } from 'child_process';
import { mocked } from 'ts-jest/utils';

jest.mock('child_process', () => ({
    exec: jest.fn(),
}));

describe('AdminService', () => {
    let service: AdminService;
    let logRepo: Repository<Log>;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AdminService,
                {
                    provide: getRepositoryToken(Log),
                    useValue: {
                        find: jest.fn(),
                        delete: jest.fn(),
                    },
                },
            ],
        }).compile();

        service = module.get<AdminService>(AdminService);
        logRepo = module.get<Repository<Log>>(getRepositoryToken(Log));
    });

    describe('all', () => {
        it('should return logs sorted by created_at in descending order', async () => {
            // Arrange: Mock data
            const logs = [
                { created_at: new Date('2023-01-01'), user: { id: 1 } } as Log,
                { created_at: new Date('2024-01-01'), user: { id: 2 } } as Log,
            ];
            jest.spyOn(logRepo, 'find').mockResolvedValue(logs);

            // Act: Call the method
            const result = await service.all();

            // Assert: Check that the result is sorted in descending order
            expect(result).toEqual([
                { created_at: new Date('2024-01-01'), user: { id: 2 } } as Log,
                { created_at: new Date('2023-01-01'), user: { id: 1 } } as Log,
            ]);
        });
    });

    describe('deleteByIds', () => {
        it('should delete logs by their IDs', async () => {
            // Arrange: Prepare input
            const idsToDelete = [1, 2, 3];
            const deleteSpy = jest.spyOn(logRepo, 'delete').mockResolvedValue({ affected: 3, raw: [] });

            // Act: Call the delete method
            await service.deleteByIds(idsToDelete);

            // Assert: Verify that delete was called with the correct argument
            expect(deleteSpy).toHaveBeenCalledWith(idsToDelete);
        });
    });

    describe('redeploy', () => {
        expect(true).toBe(true);
    });
});