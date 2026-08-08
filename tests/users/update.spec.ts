import { DataSource } from "typeorm";
import request from "supertest";
import createJWKSMock from "mock-jwks";

import { AppDataSource } from "../../src/config/data-source";
import app from "../../src/app";
import { Roles } from "../../src/constants";
import { User } from "../../src/entity/User";
import { Tenant } from "../../src/entity/Tenant";
import { createTenant, createUser } from "../utils";

describe("PATCH /users/:id", () => {
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

    describe("Given all fields", () => {
        it("should return the 200 status code and the updated user id", async () => {
            const userRepository = connection.getRepository(User);
            const tenant = await createTenant(connection.getRepository(Tenant));
            const user = await createUser(userRepository);

            const response = await request(app)
                .patch(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    firstName: "Updated",
                    lastName: "Name",
                    role: Roles.MANAGER,
                    email: user.email,
                    tenantId: tenant.id,
                });

            expect(response.statusCode).toBe(200);
            expect((response.body as Record<string, number>).id).toBe(user.id);
        });

        it("should persist the updated fields in the database", async () => {
            const userRepository = connection.getRepository(User);
            const tenant = await createTenant(connection.getRepository(Tenant));
            const user = await createUser(userRepository);

            await request(app)
                .patch(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    firstName: "Updated",
                    lastName: "Name",
                    role: Roles.MANAGER,
                    email: "updated@mern.space",
                    tenantId: tenant.id,
                });

            const updated = await userRepository.findOne({
                where: { id: user.id },
                relations: { tenant: true },
            });

            expect(updated?.firstName).toBe("Updated");
            expect(updated?.lastName).toBe("Name");
            expect(updated?.role).toBe(Roles.MANAGER);
            expect(updated?.email).toBe("updated@mern.space");
            expect(updated?.tenant?.id).toBe(tenant.id);
        });

        it("should not change the password", async () => {
            const userRepository = connection.getRepository(User);
            const tenant = await createTenant(connection.getRepository(Tenant));
            const user = await createUser(userRepository);

            await request(app)
                .patch(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    firstName: "Updated",
                    lastName: "Name",
                    role: Roles.MANAGER,
                    email: user.email,
                    tenantId: tenant.id,
                    password: "a-brand-new-password",
                });

            // password is `select: false`, so it has to be asked for.
            const updated = await userRepository.findOne({
                where: { id: user.id },
                select: { id: true, password: true },
            });

            expect(updated?.password).toBe(user.password);
        });

        it("should clear the tenant when an admin is given no tenant id", async () => {
            const userRepository = connection.getRepository(User);
            const tenant = await createTenant(connection.getRepository(Tenant));
            const user = await createUser(userRepository, {
                role: Roles.MANAGER,
                tenant,
            });

            await request(app)
                .patch(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    firstName: "Updated",
                    lastName: "Name",
                    role: Roles.ADMIN,
                    email: user.email,
                    tenantId: "",
                });

            const updated = await userRepository.findOne({
                where: { id: user.id },
                relations: { tenant: true },
            });

            expect(updated?.tenant).toBeNull();
        });
    });

    describe("Given an invalid request", () => {
        it("should return 400 if the url param is not a number", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));

            const response = await request(app)
                .patch("/users/not-a-number")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    firstName: "Updated",
                    lastName: "Name",
                    role: Roles.MANAGER,
                    email: "updated@mern.space",
                    tenantId: tenant.id,
                });

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 if firstName is missing", async () => {
            const user = await createUser(connection.getRepository(User));
            const tenant = await createTenant(connection.getRepository(Tenant));

            const response = await request(app)
                .patch(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    lastName: "Name",
                    role: Roles.MANAGER,
                    email: "updated@mern.space",
                    tenantId: tenant.id,
                });

            expect(response.statusCode).toBe(400);
        });

        it("should return 400 if the email is not a valid email", async () => {
            const user = await createUser(connection.getRepository(User));
            const tenant = await createTenant(connection.getRepository(Tenant));

            const response = await request(app)
                .patch(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    firstName: "Updated",
                    lastName: "Name",
                    role: Roles.MANAGER,
                    email: "not-an-email",
                    tenantId: tenant.id,
                });

            expect(response.statusCode).toBe(400);
        });

        it("currently accepts a non-admin role with no tenant id (validator bug)", async () => {
            // BUG, captured rather than asserted as correct.
            //
            // update-user-validator declares tenantId as required for any
            // non-admin role, with `errorMessage: "Tenant id is required!"`.
            // It never fires: the `custom.options` callback is `async`, and
            // express-validator only fails a custom validator when it throws
            // or returns a *rejected* promise. An async function that returns
            // `false` still resolves, so the check always passes.
            //
            // Result: a manager can be saved with no tenant, which the rest
            // of the system assumes cannot happen. Dropping `async` (or
            // throwing instead of returning false) makes the rule real; this
            // expectation then flips to 400.
            const user = await createUser(connection.getRepository(User));

            const response = await request(app)
                .patch(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({
                    firstName: "Updated",
                    lastName: "Name",
                    role: Roles.MANAGER,
                    email: "updated@mern.space",
                    tenantId: "",
                });

            expect(response.statusCode).toBe(200);
        });

        it("should leave the user untouched when validation fails", async () => {
            const userRepository = connection.getRepository(User);
            const user = await createUser(userRepository);

            await request(app)
                .patch(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send({ lastName: "Name" });

            const untouched = await userRepository.findOne({
                where: { id: user.id },
            });

            expect(untouched?.firstName).toBe(user.firstName);
            expect(untouched?.email).toBe(user.email);
        });
    });

    describe("Given a non-admin caller", () => {
        it("should return 401 if the user is not authenticated", async () => {
            const user = await createUser(connection.getRepository(User));

            const response = await request(app)
                .patch(`/users/${user.id}`)
                .send({
                    firstName: "Updated",
                    lastName: "Name",
                    role: Roles.ADMIN,
                    email: user.email,
                    tenantId: "",
                });

            expect(response.statusCode).toBe(401);
        });

        it("should return 403 if the user is not an admin", async () => {
            const userRepository = connection.getRepository(User);
            const user = await createUser(userRepository);
            const managerToken = jwks.token({
                sub: "1",
                role: Roles.MANAGER,
            });

            const response = await request(app)
                .patch(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${managerToken}`])
                .send({
                    firstName: "Updated",
                    lastName: "Name",
                    role: Roles.ADMIN,
                    email: user.email,
                    tenantId: "",
                });

            expect(response.statusCode).toBe(403);

            const untouched = await userRepository.findOne({
                where: { id: user.id },
            });
            expect(untouched?.firstName).toBe(user.firstName);
        });
    });
});
