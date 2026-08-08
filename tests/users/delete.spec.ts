import { DataSource } from "typeorm";
import request from "supertest";
import createJWKSMock from "mock-jwks";

import { AppDataSource } from "../../src/config/data-source";
import app from "../../src/app";
import { Roles } from "../../src/constants";
import { User } from "../../src/entity/User";
import { createUser } from "../utils";

describe("DELETE /users/:id", () => {
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
        it("should return the 200 status code and the deleted id", async () => {
            const user = await createUser(connection.getRepository(User));

            const response = await request(app)
                .delete(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(200);
            expect((response.body as Record<string, number>).id).toBe(user.id);
        });

        it("should remove the user from the database", async () => {
            const userRepository = connection.getRepository(User);
            const user = await createUser(userRepository);

            await request(app)
                .delete(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(await userRepository.find()).toHaveLength(0);
        });

        // NOT COVERED, deliberately: deleting a user who still has refresh
        // tokens (i.e. a currently logged-in user).
        //
        // The two schemas disagree. `RefreshToken.user` is a plain
        // `@ManyToOne(() => User)` with no `onDelete`, so the schema this
        // suite runs against — built by `connection.synchronize()` from the
        // entities — gives the FK ON DELETE NO ACTION and the delete fails
        // with a 500. Production is migrated, and
        // 1699475145577-add_refreshtoken_cascade re-creates the same FK with
        // ON DELETE CASCADE, where the delete succeeds.
        //
        // Either result would be asserting an environment rather than a
        // behaviour, so the case is left uncovered until the entity and the
        // migrations agree. Adding `{ onDelete: "CASCADE" }` to the relation
        // is what would close the gap.

        it("should leave other users alone", async () => {
            const userRepository = connection.getRepository(User);
            const target = await createUser(userRepository, {
                email: "target@mern.space",
            });
            const survivor = await createUser(userRepository, {
                email: "survivor@mern.space",
            });

            await request(app)
                .delete(`/users/${target.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const remaining = await userRepository.find();
            expect(remaining).toHaveLength(1);
            expect(remaining[0].id).toBe(survivor.id);
        });
    });

    describe("Given a bad request", () => {
        it("should return 400 if the url param is not a number", async () => {
            const response = await request(app)
                .delete("/users/not-a-number")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(400);
        });

        it("should return 200 for an id that does not exist", async () => {
            // Current behaviour: the controller does not check the affected
            // row count, so deleting nothing still reports success. Recorded
            // here so a future change to 404 is a deliberate one.
            const response = await request(app)
                .delete("/users/9999")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(200);
        });
    });

    describe("Access control", () => {
        it("should return 401 if the user is not authenticated", async () => {
            const userRepository = connection.getRepository(User);
            const user = await createUser(userRepository);

            const response = await request(app)
                .delete(`/users/${user.id}`)
                .send();

            expect(response.statusCode).toBe(401);
            expect(await userRepository.find()).toHaveLength(1);
        });

        it("should return 403 if the caller is not an admin", async () => {
            const userRepository = connection.getRepository(User);
            const user = await createUser(userRepository);
            const managerToken = jwks.token({
                sub: "1",
                role: Roles.MANAGER,
            });

            const response = await request(app)
                .delete(`/users/${user.id}`)
                .set("Cookie", [`accessToken=${managerToken}`])
                .send();

            expect(response.statusCode).toBe(403);
            expect(await userRepository.find()).toHaveLength(1);
        });
    });
});
