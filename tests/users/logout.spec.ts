import { DataSource } from "typeorm";
import request from "supertest";
import createJWKSMock from "mock-jwks";

import { AppDataSource } from "../../src/config/data-source";
import app from "../../src/app";
import { User } from "../../src/entity/User";
import { RefreshToken } from "../../src/entity/RefreshToken";
import { createRefreshToken, createUser, extractAuthCookies } from "../utils";

describe("POST /auth/logout", () => {
    let connection: DataSource;
    let jwks: ReturnType<typeof createJWKSMock>;

    beforeAll(async () => {
        jwks = createJWKSMock("http://localhost:5501");
        connection = await AppDataSource.initialize();
    });

    beforeEach(async () => {
        jwks.start();
        await connection.dropDatabase();
        await connection.synchronize();
    });

    afterEach(() => {
        jwks.stop();
    });

    afterAll(async () => {
        await connection.destroy();
    });

    describe("Given both tokens", () => {
        it("should return the 200 status code", async () => {
            const user = await createUser(connection.getRepository(User));
            const { token: refreshToken } = await createRefreshToken(
                connection.getRepository(RefreshToken),
                user,
            );
            const accessToken = jwks.token({
                sub: String(user.id),
                role: user.role,
            });

            const response = await request(app)
                .post("/auth/logout")
                .set("Cookie", [
                    `accessToken=${accessToken}`,
                    `refreshToken=${refreshToken}`,
                ])
                .send();

            expect(response.statusCode).toBe(200);
        });

        it("should delete the refresh token from the database", async () => {
            const user = await createUser(connection.getRepository(User));
            const refreshTokenRepository =
                connection.getRepository(RefreshToken);
            const { token: refreshToken } = await createRefreshToken(
                refreshTokenRepository,
                user,
            );
            const accessToken = jwks.token({
                sub: String(user.id),
                role: user.role,
            });

            await request(app)
                .post("/auth/logout")
                .set("Cookie", [
                    `accessToken=${accessToken}`,
                    `refreshToken=${refreshToken}`,
                ])
                .send();

            const rows = await refreshTokenRepository.find();
            expect(rows).toHaveLength(0);
        });

        it("should clear both auth cookies", async () => {
            const user = await createUser(connection.getRepository(User));
            const { token: refreshToken } = await createRefreshToken(
                connection.getRepository(RefreshToken),
                user,
            );
            const accessToken = jwks.token({
                sub: String(user.id),
                role: user.role,
            });

            const response = await request(app)
                .post("/auth/logout")
                .set("Cookie", [
                    `accessToken=${accessToken}`,
                    `refreshToken=${refreshToken}`,
                ])
                .send();

            const { raw } = extractAuthCookies(response);

            // res.clearCookie emits an empty value with an expiry in the past.
            const cleared = raw.filter((cookie) =>
                /^(accessToken|refreshToken)=;/.test(cookie),
            );
            expect(cleared).toHaveLength(2);
            cleared.forEach((cookie) => {
                expect(cookie).toContain("Expires=Thu, 01 Jan 1970");
            });
        });

        it("should leave another session's refresh token intact", async () => {
            const user = await createUser(connection.getRepository(User));
            const refreshTokenRepository =
                connection.getRepository(RefreshToken);

            // Two sessions for the same user — a phone and a laptop, say.
            const { token: phoneToken } = await createRefreshToken(
                refreshTokenRepository,
                user,
            );
            const { row: laptopRow } = await createRefreshToken(
                refreshTokenRepository,
                user,
            );

            const accessToken = jwks.token({
                sub: String(user.id),
                role: user.role,
            });

            await request(app)
                .post("/auth/logout")
                .set("Cookie", [
                    `accessToken=${accessToken}`,
                    `refreshToken=${phoneToken}`,
                ])
                .send();

            const rows = await refreshTokenRepository.find();
            expect(rows).toHaveLength(1);
            expect(rows[0].id).toBe(laptopRow.id);
        });
    });

    describe("Given missing or invalid tokens", () => {
        it("should return 401 if no tokens are sent", async () => {
            const response = await request(app).post("/auth/logout").send();

            expect(response.statusCode).toBe(401);
        });

        it("should return 401 if the access token is missing", async () => {
            const user = await createUser(connection.getRepository(User));
            const { token: refreshToken } = await createRefreshToken(
                connection.getRepository(RefreshToken),
                user,
            );

            const response = await request(app)
                .post("/auth/logout")
                .set("Cookie", [`refreshToken=${refreshToken}`])
                .send();

            expect(response.statusCode).toBe(401);
        });

        it("should return 401 if the refresh token is missing", async () => {
            const user = await createUser(connection.getRepository(User));
            const accessToken = jwks.token({
                sub: String(user.id),
                role: user.role,
            });

            const response = await request(app)
                .post("/auth/logout")
                .set("Cookie", [`accessToken=${accessToken}`])
                .send();

            expect(response.statusCode).toBe(401);
        });

        it("should not delete anything if the access token is invalid", async () => {
            const user = await createUser(connection.getRepository(User));
            const refreshTokenRepository =
                connection.getRepository(RefreshToken);
            const { token: refreshToken } = await createRefreshToken(
                refreshTokenRepository,
                user,
            );

            const response = await request(app)
                .post("/auth/logout")
                .set("Cookie", [
                    `accessToken=not-a-jwt`,
                    `refreshToken=${refreshToken}`,
                ])
                .send();

            expect(response.statusCode).toBe(401);
            expect(await refreshTokenRepository.find()).toHaveLength(1);
        });
    });
});
