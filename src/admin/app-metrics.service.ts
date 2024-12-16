import { Injectable } from "@nestjs/common";
import Redis from 'ioredis';


@Injectable()
export class AppMetricsService {
    private readonly redis: Redis;

    // Max length of string values to dump
    private readonly maxLength = 200; // You can change this to whatever suits your needs

    constructor(
    ) {
        this.redis = new Redis({
            host: process.env.REDIS_HOST,
            port: Number(process.env.REDIS_PORT),
            password: process.env.REDIS_PASSWORD,
        });
    }

    public async redisInfo(section: string): Promise<string> {
        return await this.redis.info(section);
    }

    // Method to dump all Redis keys and their values
    public async dumpRedisCache() {
        const allKeys: string[] = await this.getAllKeys();
        const keyValuePairs: Record<string, string | object> = {};

        for (const key of allKeys) {
            const value = await this.redis.get(key); // This works for string values
            if (value) {
                keyValuePairs[key] = this.trimString(value); // Trim long string values
            } else {
                // If the value is not a string, try other types like hashes, lists, etc.
                const hashValue = await this.redis.hgetall(key);
                if (Object.keys(hashValue).length > 0) {
                    keyValuePairs[key] = hashValue;
                }

                const listValue = await this.redis.lrange(key, 0, -1); // List
                if (listValue.length > 0) {
                    keyValuePairs[key] = listValue;
                }

                const setValue = await this.redis.smembers(key); // Set
                if (setValue.length > 0) {
                    keyValuePairs[key] = setValue;
                }

                const zsetValue = await this.redis.zrange(key, 0, -1); // Sorted Set
                if (zsetValue.length > 0) {
                    keyValuePairs[key] = zsetValue;
                }
            }
        }
        return keyValuePairs; // You can log it, return it, or store it as needed.

    }

    // Helper method to fetch all keys using SCAN to avoid blocking the Redis server
    private async getAllKeys(): Promise<string[]> {
        let cursor = '0';
        let allKeys: string[] = [];

        do {
            const result = await this.redis.scan(cursor);
            cursor = result[0];
            allKeys = allKeys.concat(result[1]);
        } while (cursor !== '0'); // Continue until all keys are retrieved

        return allKeys;
    }

    // Helper method to trim long string values
    private trimString(value: string): string {
        if (value.length > this.maxLength) {
            return value.slice(0, this.maxLength) + '...'; // Truncate and add ellipsis
        }
        return value; // Return the string as-is if it's shorter than maxLength
    }
}