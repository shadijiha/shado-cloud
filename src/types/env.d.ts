declare global {
	namespace NodeJS {
		interface ProcessEnv {
			COOKIE_NAME: string;
			ENV: "dev" | "prod";
			JWT_SECRET: string;
			FRONTEND_URL: string;
			BACKEND_HOST: string;
			BACKEND_HOST_NAME: string;
			CLOUD_DIR: string;
			DB_TYPE: string;
			DB_HOST: string;
			DB_PORT: string;
			DB_USERNAME: string;
			DB_PASSWORD: string;
			DB_NAME: string;
			PASSWORD_VAULT_SALT: string;
		}
	}
}

// If this file has no import/export statements (i.e. is a script)
// convert it into a module by adding an empty export statement.
export {};
