type LocalApiKey = {
	apiKey: string;
};

const cookieHeader = (response: Response): string => {
	const cookies = response.headers.getSetCookie?.() ?? [];
	const values =
		cookies.length > 0 ? cookies : [response.headers.get("set-cookie")];

	return values
		.filter((value): value is string => Boolean(value))
		.map((value) => value.split(";", 1)[0])
		.join("; ");
};

/**
 * Local scripts authenticate exactly like an external client. A fresh account
 * avoids any hidden administrative path or dependency on existing local data.
 */
export const createLocalApiKey = async (
	baseUrl: string,
	name: string,
): Promise<LocalApiKey> => {
	const origin = process.env.LUMIN_AUTH_ORIGIN ?? "http://localhost:3000";
	const suffix = crypto.randomUUID();
	const password = crypto.randomUUID();
	const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name,
			email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}@example.test`,
			password,
		}),
	});

	if (!signUp.ok) {
		throw new Error(
			`Local sign-up failed with ${signUp.status}: ${await signUp.text()}`,
		);
	}

	const cookie = cookieHeader(signUp);
	if (!cookie)
		throw new Error("Local sign-up did not return a session cookie.");

	const keyResponse = await fetch(`${baseUrl}/api/auth/api-key/create`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie,
			origin,
		},
		body: JSON.stringify({ name }),
	});

	const key = (await keyResponse.json().catch(() => null)) as {
		key?: unknown;
	} | null;
	if (!keyResponse.ok || typeof key?.key !== "string") {
		throw new Error(
			`Local API-key creation failed with ${keyResponse.status}.`,
		);
	}

	return { apiKey: key.key };
};
