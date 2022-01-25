/**
 * A soft exception is an exception that doesn't need to be logged
 */

export class SoftException extends Error {
	public constructor(message?: string) {
		super(message);
	}
}
