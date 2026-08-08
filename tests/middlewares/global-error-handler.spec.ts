import { NextFunction, Request, Response } from "express";
import createHttpError, { HttpError } from "http-errors";

import { globalErrorHandler } from "../../src/middlewares/globalErrorHandler";

interface ErrorEnvelope {
    errors: {
        ref: string;
        type: string;
        msg: string;
        path: string;
        method: string;
        location: string;
        stack: string | null;
    }[];
}

describe("globalErrorHandler", () => {
    const makeResponse = () => {
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
        return res as unknown as Response & {
            status: jest.Mock;
            json: jest.Mock;
        };
    };

    const req = { path: "/auth/login", method: "POST" } as Request;
    const next = jest.fn() as unknown as NextFunction;

    const bodyOf = (res: { json: jest.Mock }) =>
        res.json.mock.calls[0][0] as ErrorEnvelope;

    it("should use the status carried by the error", () => {
        const res = makeResponse();

        globalErrorHandler(
            createHttpError(403, "You don't have enough permissions"),
            req,
            res,
            next,
        );

        expect(res.status).toHaveBeenCalledWith(403);
    });

    it("should fall back to 500 for an error with no status", () => {
        const res = makeResponse();

        globalErrorHandler(new Error("boom") as HttpError, req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
    });

    it("should pass the real message through for a 400", () => {
        const res = makeResponse();

        globalErrorHandler(
            createHttpError(400, "Email or password does not match."),
            req,
            res,
            next,
        );

        expect(bodyOf(res).errors[0].msg).toBe(
            "Email or password does not match.",
        );
    });

    it("should hide the message behind a generic one for any other status", () => {
        // A 500 must not leak internals — a Postgres error string, say — to
        // the client. Only 400s are considered safe to echo back.
        const res = makeResponse();

        globalErrorHandler(
            new Error(
                'duplicate key value violates unique constraint "users_email_key"',
            ) as HttpError,
            req,
            res,
            next,
        );

        expect(bodyOf(res).errors[0].msg).toBe("Internal server error");
    });

    it("should not leak the message of a 403 either", () => {
        const res = makeResponse();

        globalErrorHandler(
            createHttpError(403, "You don't have enough permissions"),
            req,
            res,
            next,
        );

        expect(bodyOf(res).errors[0].msg).toBe("Internal server error");
    });

    it("should return the standard envelope", () => {
        const res = makeResponse();

        globalErrorHandler(createHttpError(400, "Bad input"), req, res, next);

        const error = bodyOf(res).errors[0];

        expect(error.type).toBe("BadRequestError");
        expect(error.path).toBe("/auth/login");
        expect(error.method).toBe("POST");
        expect(error.location).toBe("server");
    });

    it("should attach a unique reference id to every error", () => {
        const first = makeResponse();
        const second = makeResponse();

        globalErrorHandler(createHttpError(400, "Bad input"), req, first, next);
        globalErrorHandler(
            createHttpError(400, "Bad input"),
            req,
            second,
            next,
        );

        // The ref is what ties a client-visible error to a log line.
        expect(bodyOf(first).errors[0].ref).toEqual(expect.any(String));
        expect(bodyOf(first).errors[0].ref).not.toBe(
            bodyOf(second).errors[0].ref,
        );
    });

    it("should include the stack outside production", () => {
        const res = makeResponse();

        globalErrorHandler(createHttpError(400, "Bad input"), req, res, next);

        expect(bodyOf(res).errors[0].stack).toEqual(expect.any(String));
    });

    it("should null the stack in production", () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";

        try {
            const res = makeResponse();

            globalErrorHandler(
                createHttpError(400, "Bad input"),
                req,
                res,
                next,
            );

            expect(bodyOf(res).errors[0].stack).toBeNull();
        } finally {
            process.env.NODE_ENV = previous;
        }
    });
});
