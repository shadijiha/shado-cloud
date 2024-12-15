import { Test, TestingModule } from '@nestjs/testing';
import { AdminGuard } from 'src/admin/admin.strategy';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from 'src/models/user';
import { Repository } from 'typeorm';
import { ExecutionContext, Request } from '@nestjs/common';
import { parseJwt } from 'src/util';
import { CookiePayload } from 'src/auth/authApiTypes';
import { AuthStrategy } from 'src/auth/auth.strategy';
import { JwtModule } from '@nestjs/jwt';

describe('AuthStrategy', () => {
    let stategy: AuthStrategy;

    beforeEach(async () => {
        process.env = Object.assign(process.env, { JWT_SECRET: 'test' } as const);

        const module: TestingModule = await Test.createTestingModule({
            imports: [JwtModule.register({
                secret: process.env.JWT_SECRET,
                signOptions: {
                    expiresIn: "24h",
                },
            })],
            providers: [
                AuthStrategy,
            ],
        }).compile();

        stategy = module.get<AuthStrategy>(AuthStrategy);  
    });

    it('should be defined', () => {
        expect(stategy).toBeDefined();
    });

    describe('validate', () => {
        it('should always return true', async () => {
            const data: CookiePayload = {
                userId: 1
            };

            const result = await stategy.validate(data);
            expect(result).toBe(true);
        });
    });
});
