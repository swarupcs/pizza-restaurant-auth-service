import { DataSource } from "typeorm";
import { sign } from "jsonwebtoken";
import request from "supertest";

import { AppDataSource } from "../../src/config/data-source";
import app from "../../src/app";
import { User } from "../../src/entity/User";
import { RefreshToken } from "../../src/entity/RefreshToken";
import { Roles } from "../../src/constants";
import {
    createRefreshToken,
    createUser,
    extractAuthCookies,
    isJwt,
} from "../utils";

describe("POST /auth/refresh", () => {
    let connection: DataSource;

    beforeAll(async () => {
        connection = await AppDataSource.initialize();
    });

    beforeEach(async () => {
        await connection.dropDatabase();
        await connection.synchronize();
    });

    afterAll(async () => {
        await connection.destroy();
    });

    describe("Given a valid refresh token", () => {
        it("should return the 200 status code", async () => {
            const user = await createUser(connection.getRepository(User));
            const { token } = await createRefreshToken(
                connection.getRepository(RefreshToken),
                user,
            );

            const response = await request(app)
                .post("/auth/refresh")
                .set("Cookie", [`refreshToken=${token}`])
                .send();

            expect(response.statusCode).toBe(200);
        });

        it("should return the id of the user", async () => {
            const user = await createUser(connection.getRepository(User));
            const { token } = await createRefreshToken(
                connection.getRepository(RefreshToken),
                user,
            );

            const response = await request(app)
                .post("/auth/refresh")
                .set("Cookie", [`refreshToken=${token}`])
                .send();

            expect((response.body as Record<string, number>).id).toBe(user.id);
        });

        it("should set a fresh access token and refresh token inside a cookie", async () => {
            const user = await createUser(connection.getRepository(User));
            const { token } = await createRefreshToken(
                connection.getRepository(RefreshToken),
                user,
            );

            const response = await request(app)
                .post("/auth/refresh")
                .set("Cookie", [`refreshToken=${token}`])
                .send();

            const { accessToken, refreshToken } = extractAuthCookies(response);

            expect(accessToken).not.toBeNull();
            expect(refreshToken).not.toBeNull();
            expect(isJwt(accessToken)).toBeTruthy();
            expect(isJwt(refreshToken)).toBeTruthy();

            // A refresh that hands back the token it was given would defeat
            // the point of rotation.
            expect(refreshToken).not.toBe(token);
        });

        it("should rotate the refresh token row: persist a new one and delete the old one", async () => {
            const user = await createUser(connection.getRepository(User));
            const refreshTokenRepository =
                connection.getRepository(RefreshToken);
            const { token, row } = await createRefreshToken(
                refreshTokenRepository,
                user,
            );

            await request(app)
                .post("/auth/refresh")
                .set("Cookie", [`refreshToken=${token}`])
                .send();

            const rows = await refreshTokenRepository.find();

            expect(rows).toHaveLength(1);
            expect(rows[0].id).not.toBe(row.id);
        });

        it("should reject the old refresh token once it has been rotated", async () => {
            const user = await createUser(connection.getRepository(User));
            const { token } = await createRefreshToken(
                connection.getRepository(RefreshToken),
                user,
            );

            await request(app)
                .post("/auth/refresh")
                .set("Cookie", [`refreshToken=${token}`])
                .send();

            // Same token, second use. The row backing it is gone, so
            // `isRevoked` must reject it even though the signature is valid.
            const response = await request(app)
                .post("/auth/refresh")
                .set("Cookie", [`refreshToken=${token}`])
                .send();

            expect(response.statusCode).toBe(401);
        });
    });

    describe("Given an invalid refresh token", () => {
        it("should return 401 if the refresh token cookie is missing", async () => {
            const response = await request(app).post("/auth/refresh").send();

            expect(response.statusCode).toBe(401);
        });

        it("should return 401 if the token is signed with the wrong secret", async () => {
            const user = await createUser(connection.getRepository(User));
            const { row } = await createRefreshToken(
                connection.getRepository(RefreshToken),
                user,
            );

            const forged = sign(
                { sub: String(user.id), role: user.role, id: String(row.id) },
                "not-the-refresh-token-secret",
                { algorithm: "HS256", expiresIn: "1y", jwtid: String(row.id) },
            );

            const response = await request(app)
                .post("/auth/refresh")
                .set("Cookie", [`refreshToken=${forged}`])
                .send();

            expect(response.statusCode).toBe(401);
        });

        it("should return 401 if the token has no matching row in the database", async () => {
            const user = await createUser(connection.getRepository(User));
            const refreshTokenRepository =
                connection.getRepository(RefreshToken);
            const { token, row } = await createRefreshToken(
                refreshTokenRepository,
                user,
            );

            // Simulates a logout, or an admin revoking the session.
            await refreshTokenRepository.delete({ id: row.id });

            const response = await request(app)
                .post("/auth/refresh")
                .set("Cookie", [`refreshToken=${token}`])
                .send();

            expect(response.statusCode).toBe(401);
        });

        it("should return 401 if the token id belongs to a different user", async () => {
            const userRepository = connection.getRepository(User);
            const owner = await createUser(userRepository);
            const attacker = await createUser(userRepository, {
                email: "attacker@mern.space",
            });

            const refreshTokenRepository =
                connection.getRepository(RefreshToken);
            const { row } = await createRefreshToken(
                refreshTokenRepository,
                owner,
            );

            // Correctly signed, but claims the attacker owns the owner's
            // token row. The lookup is keyed on (token id, user id), so it
            // must find nothing.
            const crossToken = sign(
                {
                    sub: String(attacker.id),
                    role: attacker.role,
                    id: String(row.id),
                },
                process.env.REFRESH_TOKEN_SECRET!,
                { algorithm: "HS256", expiresIn: "1y", jwtid: String(row.id) },
            );

            const response = await request(app)
                .post("/auth/refresh")
                .set("Cookie", [`refreshToken=${crossToken}`])
                .send();

            expect(response.statusCode).toBe(401);
        });

        it("should return 401 if the token has expired", async () => {
            const user = await createUser(connection.getRepository(User));
            const refreshTokenRepository =
                connection.getRepository(RefreshToken);
            const { row } = await createRefreshToken(
                refreshTokenRepository,
                user,
            );

            const expired = sign(
                {
                    sub: String(user.id),
                    role: Roles.CUSTOMER,
                    id: String(row.id),
                },
                process.env.REFRESH_TOKEN_SECRET!,
                { algorithm: "HS256", expiresIn: "-1h", jwtid: String(row.id) },
            );

            const response = await request(app)
                .post("/auth/refresh")
                .set("Cookie", [`refreshToken=${expired}`])
                .send();

            expect(response.statusCode).toBe(401);
        });
    });
});
