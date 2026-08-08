import "reflect-metadata";

import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import authRouter from "./routes/auth";
import tenantRouter from "./routes/tenant";
import userRouter from "./routes/user";
import { globalErrorHandler } from "./middlewares/globalErrorHandler";
import { Config } from "./config";

const app = express();
const ALLOWED_DOMAINS = [Config.CLIENT_UI_DOMAIN, Config.ADMIN_UI_DOMAIN];

app.use(cors({ origin: ALLOWED_DOMAINS as string[], credentials: true }));

// `dotfiles: "allow"` is required, not cosmetic. serve-static 2 (Express 5)
// defaults to "ignore", which 404s any path containing a dot-segment — and
// the JWKS document lives at /.well-known/jwks.json. Without this, every
// other service's jwks-rsa client fails to fetch the signing key and no
// access token can be validated anywhere. serve-static 1 (Express 4) served
// it, so this only became necessary on the Express 5 upgrade.
app.use(express.static("public", { dotfiles: "allow" }));
app.use(cookieParser());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("Welcome to Auth service from K8s");
});

app.use("/auth", authRouter);
app.use("/tenants", tenantRouter);
app.use("/users", userRouter);

app.use(globalErrorHandler);

export default app;
