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

app.use(express.static("public"));
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
