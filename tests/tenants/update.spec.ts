import { DataSource } from "typeorm";
import request from "supertest";
import createJWKSMock from "mock-jwks";

import { AppDataSource } from "../../src/config/data-source";
import app from "../../src/app";
import { Tenant } from "../../src/entity/Tenant";
import { Roles } from "../../src/constants";
import { createTenant } from "../utils";

describe("PATCH /tenants/:id", () => {
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

    describe("Given all fields", () => {
        it("should return the 200 status code and the tenant id", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));

            const response = await request(app)
                .patch(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "Updated name", address: "Updated address" });

            expect(response.statusCode).toBe(200);
            expect((response.body as Record<string, number>).id).toBe(
                tenant.id,
            );
        });

        it("should persist the update in the database", async () => {
            const tenantRepository = connection.getRepository(Tenant);
            const tenant = await createTenant(tenantRepository);

            await request(app)
                .patch(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "Updated name", address: "Updated address" });

            const updated = await tenantRepository.findOne({
                where: { id: tenant.id },
            });

            expect(updated?.name).toBe("Updated name");
            expect(updated?.address).toBe("Updated address");
        });

        it("should trim the submitted fields", async () => {
            const tenantRepository = connection.getRepository(Tenant);
            const tenant = await createTenant(tenantRepository);

            await request(app)
                .patch(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "  Updated name  ", address: "  Address  " });

            const updated = await tenantRepository.findOne({
                where: { id: tenant.id },
            });

            expect(updated?.name).toBe("Updated name");
            expect(updated?.address).toBe("Address");
        });

        it("should leave other tenants alone", async () => {
            const tenantRepository = connection.getRepository(Tenant);
            const target = await createTenant(tenantRepository);
            const other = await tenantRepository.save({
                name: "Other tenant",
                address: "Other address",
            });

            await request(app)
                .patch(`/tenants/${target.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "Updated name", address: "Updated address" });

            const untouched = await tenantRepository.findOne({
                where: { id: other.id },
            });

            expect(untouched?.name).toBe("Other tenant");
        });
    });

    describe("Given a bad request", () => {
        it("should return 400 if the url param is not a number", async () => {
            const response = await request(app)
                .patch("/tenants/not-a-number")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "Updated name", address: "Updated address" });

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 if the name is missing", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));

            const response = await request(app)
                .patch(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ address: "Updated address" });

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 if the address is missing", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));

            const response = await request(app)
                .patch(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "Updated name" });

            expect(response.statusCode).toBe(400);
        });

        it("should leave the tenant untouched when validation fails", async () => {
            const tenantRepository = connection.getRepository(Tenant);
            const tenant = await createTenant(tenantRepository);

            await request(app)
                .patch(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ name: "" });

            const untouched = await tenantRepository.findOne({
                where: { id: tenant.id },
            });

            expect(untouched?.name).toBe("Test tenant");
        });
    });

    describe("Access control", () => {
        it("should return 401 if the user is not authenticated", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));

            const response = await request(app)
                .patch(`/tenants/${tenant.id}`)
                .send({ name: "Updated name", address: "Updated address" });

            expect(response.statusCode).toBe(401);
        });

        it("should return 403 if the caller is not an admin", async () => {
            const tenantRepository = connection.getRepository(Tenant);
            const tenant = await createTenant(tenantRepository);
            const managerToken = jwks.token({
                sub: "1",
                role: Roles.MANAGER,
            });

            const response = await request(app)
                .patch(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${managerToken}`])
                .send({ name: "Updated name", address: "Updated address" });

            expect(response.statusCode).toBe(403);

            const untouched = await tenantRepository.findOne({
                where: { id: tenant.id },
            });
            expect(untouched?.name).toBe("Test tenant");
        });
    });
});
