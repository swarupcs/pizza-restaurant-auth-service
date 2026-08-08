import bcrypt from "bcryptjs";
import { CredentialService } from "../../src/services/CredentialService";

// Pure unit tests — no database, no HTTP.
describe("CredentialService", () => {
    const credentialService = new CredentialService();

    describe("comparePassword", () => {
        it("should return true for the correct password", async () => {
            const hash = await bcrypt.hash("secret-password", 10);

            await expect(
                credentialService.comparePassword("secret-password", hash),
            ).resolves.toBe(true);
        });

        it("should return false for the wrong password", async () => {
            const hash = await bcrypt.hash("secret-password", 10);

            await expect(
                credentialService.comparePassword("wrong-password", hash),
            ).resolves.toBe(false);
        });

        it("should be case sensitive", async () => {
            const hash = await bcrypt.hash("secret-password", 10);

            await expect(
                credentialService.comparePassword("SECRET-PASSWORD", hash),
            ).resolves.toBe(false);
        });

        it("should not treat a prefix of the password as a match", async () => {
            const hash = await bcrypt.hash("secret-password", 10);

            await expect(
                credentialService.comparePassword("secret", hash),
            ).resolves.toBe(false);
        });

        it("should return false for an empty password", async () => {
            const hash = await bcrypt.hash("secret-password", 10);

            await expect(
                credentialService.comparePassword("", hash),
            ).resolves.toBe(false);
        });

        it("should return false when the stored value is not a bcrypt hash", async () => {
            // Guards the case where a row somehow holds a plaintext password:
            // it must not authenticate just because the strings are equal.
            await expect(
                credentialService.comparePassword(
                    "secret-password",
                    "secret-password",
                ),
            ).resolves.toBe(false);
        });
    });
});
