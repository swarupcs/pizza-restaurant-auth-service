import { DataSource } from "typeorm";
import request from "supertest";
import createJWKSMock from "mock-jwks";

import { AppDataSource } from "../../src/config/data-source";
import app from "../../src/app";
import { Roles } from "../../src/constants";
import { User } from "../../src/entity/User";
import { Tenant } from "../../src/entity/Tenant";
import { createTenant, createUser } from "../utils";

describe("GET /users/:id", () => {
    let connection: DataSource;
    let jwks: ReturnType<typeof createJWKSMock>;
    let adminToken: string;

    beforeAll(async () => {
        jwks = createJWKSMock("http://localhost:5501");
        connection = await AppDataSource.initialize();
    });

    beforeEach(async () => {
        jwks.start();
        await connection.dropDatabase();
        await connection.synchronize();

        adminToken = jwks.token({ sub: "1", role: Roles.ADMIN });
    });

    afterEach(() => {
        jwks.stop();
    });

    afterAll(async () => {
        await connection.destroy();
    });

    describe("Given an existing user", () => {
        it("should return the 200 status code", async () => {
            const user = await createUser(connection.getRepository(User));

            const response = await request(app)
                .get(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(200);
        });

        it("should return the user", async () => {
            const user = await createUser(connection.getRepository(User));

            const response = await request(app)
                .get(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as User;

            expect(body.id).toBe(user.id);
            expect(body.email).toBe(user.email);
            expect(body.role).toBe(user.role);
        });

        it("should not leak the password field", async () => {
            const user = await createUser(connection.getRepository(User));

            const response = await request(app)
                .get(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.body as User).not.toHaveProperty("password");
        });

        it("should include the tenant", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));
            const user = await createUser(connection.getRepository(User), {
                role: Roles.MANAGER,
                tenant,
            });

            const response = await request(app)
                .get(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect((response.body as User).tenant?.id).toBe(tenant.id);
        });
    });

    describe("Given a bad request", () => {
        it("should return 400 if the url param is not a number", async () => {
            const response = await request(app)
                .get("/users/not-a-number")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 if the user does not exist", async () => {
            const response = await request(app)
                .get("/users/9999")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(400);
        });
    });

    describe("Access control", () => {
        it("should return 401 if the user is not authenticated", async () => {
            const user = await createUser(connection.getRepository(User));

            const response = await request(app).get(`/users/${user.id}`).send();

            expect(response.statusCode).toBe(401);
        });

        it("should return 403 if the caller is not an admin", async () => {
            const user = await createUser(connection.getRepository(User));
            const managerToken = jwks.token({
                sub: "1",
                role: Roles.MANAGER,
            });

            const response = await request(app)
                .get(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${managerToken}`])
                .send();

            expect(response.statusCode).toBe(403);
        });
    });
});
