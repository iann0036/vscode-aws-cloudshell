// Minimal ambient declaration for the untyped `aws4` package.
declare module 'aws4' {
	interface SignRequest {
		host?: string;
		hostname?: string;
		service?: string;
		region?: string;
		method?: string;
		path?: string;
		headers?: { [key: string]: any };
		body?: string;
		signQuery?: boolean;
	}

	interface SignedRequest extends SignRequest {
		hostname: string;
		path: string;
		headers: { [key: string]: any };
		body?: string;
	}

	export function sign(request: SignRequest, credentials?: any): SignedRequest;
}
