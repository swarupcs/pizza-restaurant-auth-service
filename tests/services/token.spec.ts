import fs from "node:fs";
import path from "node:path";
import { JwtPayload, verify, decode } from "jsonwebtoken";
import { Repository } from "typeorm";

import { TokenService } from "../../src/services/TokenService";
import { RefreshToken } from "../../src/entity/RefreshToken";
import { User } from "../../src/entity/User";
import { Roles } from "../../src/constants";
import { isJwt } from "../utils";

// Unit tests. The repository is a stub, so nothing here touches Postgres —
// but the signing half does use the real key pair in certs/, because the
// whole point of these tests is that other services can verify what we sign.
describe("TokenService", () => {
    const publicKey = fs.readFileSync(
        path.join(__dirname, "../../certs/public.pem"),
    );

    const makeRepository = () =>
        ({
            save: jest.fn(),
            delete: jest.fn(),
        }) as unknown as Repository<RefreshToken> & {
            save: jest.Mock;
            delete: jest.Mock;
        };

    const payload: JwtPayload = {
        sub: "1",
        role: Roles.CUSTOMER,
        tenant: "",
        firstName: "Rakesh",
        lastName: "K",
        email: "rakesh@mern.space",
    };

    describe("generateAccessToken", () => {
        it("should return a jwt", () => {
            const tokenService = new TokenService(makeRepository());

            const token = tokenService.generateAccessToken(payload);

            expect(isJwt(token)).toBeTruthy();
        });

        it("should sign with RS256 so the other services can verify it", () => {
            const tokenService = new TokenService(makeRepository());

            const token = tokenService.generateAccessToken(payload);
            const header = (
                decode(token, { complete: true }) as {
                    header: { alg: string };
                }
            ).header;

            expect(header.alg).toBe("RS256");
        });

        it("should produce a token that verifies against the public key", () => {
            const tokenService = new TokenService(makeRepository());

            const token = tokenService.generateAccessToken(payload);
            const verified = verify(token, publicKey, {
                algorithms: ["RS256"],
            }) as JwtPayload;

            expect(verified.sub).toBe("1");
            expect(verified.role).toBe(Roles.CUSTOMER);
            expect(verified.email).toBe("rakesh@mern.space");
        });

        it("should set the auth-service issuer", () => {
            const tokenService = new TokenService(makeRepository());

            const token = tokenService.generateAccessToken(payload);
            const verified = verify(token, publicKey, {
                algorithms: ["RS256"],
            }) as JwtPayload;

            expect(verified.iss).toBe("auth-service");
        });

        it("should expire in a day", () => {
            const tokenService = new TokenService(makeRepository());

            const token = tokenService.generateAccessToken(payload);
            const verified = verify(token, publicKey, {
                algorithms: ["RS256"],
            }) as JwtPayload;

            const lifetime = verified.exp! - verified.iat!;
            expect(lifetime).toBe(60 * 60 * 24);
        });

        it("should throw a 500 if the private key cannot be read", () => {
            // This is the failure mode when a deploy forgets to materialise
            // certs/ from PRIVATE_KEY_BASE64: every login 500s.
            const spy = jest
                .spyOn(fs, "readFileSync")
                .mockImplementation(() => {
                    throw new Error("ENOENT");
                });

            const tokenService = new TokenService(makeRepository());

            try {
                expect(() => tokenService.generateAccessToken(payload)).toThrow(
                    "Error while reading private key",
                );
            } finally {
                spy.mockRestore();
            }
        });
    });

    describe("generateRefreshToken", () => {
        it("should sign with HS256 against the shared secret", () => {
            const tokenService = new TokenService(makeRepository());

            const token = tokenService.generateRefreshToken({
                ...payload,
                id: "42",
            });
            const verified = verify(token, process.env.REFRESH_TOKEN_SECRET!, {
                algorithms: ["HS256"],
            }) as JwtPayload;

            expect(verified.sub).toBe("1");
        });

        it("should set the jwt id to the persisted row id", () => {
            // The jti is what makes a refresh token revocable: it points at
            // the refreshTokens row that validateRefreshToken looks up.
            const tokenService = new TokenService(makeRepository());

            const token = tokenService.generateRefreshToken({
                ...payload,
                id: "42",
            });
            const verified = verify(token, process.env.REFRESH_TOKEN_SECRET!, {
                algorithms: ["HS256"],
            }) as JwtPayload;

            expect(verified.jti).toBe("42");
            expect((verified as JwtPayload & { id: string }).id).toBe("42");
        });

        it("should expire in a year", () => {
            const tokenService = new TokenService(makeRepository());

            const token = tokenService.generateRefreshToken({
                ...payload,
                id: "42",
            });
            const verified = verify(token, process.env.REFRESH_TOKEN_SECRET!, {
                algorithms: ["HS256"],
            }) as JwtPayload;

            // jsonwebtoken resolves "1y" through `ms`, which counts a year as
            // 365.25 days. persistRefreshToken computes the row's expiresAt
            // as a flat 365, so the stored row lapses about six hours before
            // the token it backs. Harmless — the row is what gates
            // revocation, and it expires first — but the two are worth
            // keeping in view.
            const lifetime = verified.exp! - verified.iat!;
            expect(lifetime).toBe(Math.round(60 * 60 * 24 * 365.25));
        });

        it("should not be verifiable with the wrong secret", () => {
            const tokenService = new TokenService(makeRepository());

            const token = tokenService.generateRefreshToken({
                ...payload,
                id: "42",
            });

            expect(() =>
                verify(token, "some-other-secret", { algorithms: ["HS256"] }),
            ).toThrow();
        });
    });

    describe("persistRefreshToken", () => {
        it("should save a row for the user expiring in a year", async () => {
            const repository = makeRepository();
            repository.save.mockResolvedValue({ id: 1 });
            const tokenService = new TokenService(repository);

            const user = { id: 1 } as User;
            const before = Date.now();
            await tokenService.persistRefreshToken(user);
            const after = Date.now();

            expect(repository.save).toHaveBeenCalledTimes(1);

            const saved = repository.save.mock.calls[0][0] as {
                user: User;
                expiresAt: Date;
            };
            const MS_IN_YEAR = 1000 * 60 * 60 * 24 * 365;

            expect(saved.user).toBe(user);
            expect(saved.expiresAt.getTime()).toBeGreaterThanOrEqual(
                before + MS_IN_YEAR,
            );
            expect(saved.expiresAt.getTime()).toBeLessThanOrEqual(
                after + MS_IN_YEAR,
            );
        });

        it("should return the saved row", async () => {
            const repository = makeRepository();
            repository.save.mockResolvedValue({ id: 7 });
            const tokenService = new TokenService(repository);

            const row = await tokenService.persistRefreshToken({
                id: 1,
            } as User);

            expect(row.id).toBe(7);
        });
    });

    describe("deleteRefreshToken", () => {
        it("should delete by the token id", async () => {
            const repository = makeRepository();
            repository.delete.mockResolvedValue({ affected: 1 });
            const tokenService = new TokenService(repository);

            await tokenService.deleteRefreshToken(42);

            expect(repository.delete).toHaveBeenCalledWith({ id: 42 });
        });
    });
});
