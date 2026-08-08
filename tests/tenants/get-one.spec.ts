import { DataSource } from "typeorm";
import request from "supertest";
import createJWKSMock from "mock-jwks";

import { AppDataSource } from "../../src/config/data-source";
import app from "../../src/app";
import { Tenant } from "../../src/entity/Tenant";
import { Roles } from "../../src/constants";
import { createTenant } from "../utils";

describe("GET /tenants/:id", () => {
    let connection: DataSource;
    let jwks: ReturnType<typeof createJWKSMock>;
    let adminToken: string;

    beforeAll(async () => {
        connection = await AppDataSource.initialize();
        jwks = createJWKSMock("http://localhost:5501");
    });

    beforeEach(async () => {
        await connection.dropDatabase();
        await connection.synchronize();
        jwks.start();

        adminToken = jwks.token({ sub: "1", role: Roles.ADMIN });
    });

    afterEach(() => {
        jwks.stop();
    });

    afterAll(async () => {
        await connection.destroy();
    });

    describe("Given an existing tenant", () => {
        it("should return the 200 status code", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));

            const response = await request(app)
                .get(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(200);
        });

        it("should return the tenant", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));

            const response = await request(app)
                .get(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as Tenant;

            expect(body.id).toBe(tenant.id);
            expect(body.name).toBe("Test tenant");
            expect(body.address).toBe("Test address");
        });
    });

    describe("Given a bad request", () => {
        it("should return 400 if the url param is not a number", async () => {
            const response = await request(app)
                .get("/tenants/not-a-number")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 if the tenant does not exist", async () => {
            const response = await request(app)
                .get("/tenants/9999")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(400);
        });
    });

    describe("Access control", () => {
        it("should return 401 if the user is not authenticated", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));

            const response = await request(app)
                .get(`/tenants/${tenant.id}`)
                .send();

            expect(response.statusCode).toBe(401);
        });

        it("should return 403 if the caller is not an admin", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));
            const managerToken = jwks.token({
                sub: "1",
                role: Roles.MANAGER,
            });

            const response = await request(app)
                .get(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${managerToken}`])
                .send();

            expect(response.statusCode).toBe(403);
        });
    });
});
