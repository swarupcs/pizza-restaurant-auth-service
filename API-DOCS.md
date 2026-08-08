# Auth Service — API Documentation

> **Base URL:** `http://localhost:5501`  
> **Postman Collection:** [`Auth-Service.postman_collection.json`](./Auth-Service.postman_collection.json)

## Overview

The Auth Service handles all user identity concerns: registration, login, token management, tenant (restaurant) management, and admin-level user management.

### Authentication Mechanism

All protected endpoints rely on **httpOnly cookies** set automatically after a successful login or register:

| Cookie         | Lifetime | Purpose                                     |
| -------------- | -------- | ------------------------------------------- |
| `accessToken`  | 1 day    | Short-lived JWT for authenticating requests |
| `refreshToken` | 1 year   | Long-lived JWT used to rotate tokens        |

Cookies are sent automatically by the browser or Postman (when cookie handling is enabled). **No `Authorization` header is needed.**

### Roles

| Role       | Description                                                       |
| ---------- | ----------------------------------------------------------------- |
| `customer` | Self-registered via `/auth/register`. Can view their own profile. |
| `manager`  | Created by admin. Scoped to a single tenant (restaurant).         |
| `admin`    | Platform administrator. Full access to all resources.             |

---

## 🔐 Auth Endpoints

Base path: `/auth`

---

### `POST /auth/register`

Register a new customer account.

**Auth required:** None (public)

**Request Body** (`application/json`):

```json
{
    "firstName": "Swarup",
    "lastName": "Das",
    "email": "swarup@example.com",
    "password": "secret@123"
}
```

| Field       | Type   | Required | Validation         |
| ----------- | ------ | -------- | ------------------ |
| `firstName` | string | ✅       | Non-empty          |
| `lastName`  | string | ✅       | Non-empty          |
| `email`     | string | ✅       | Valid email format |
| `password`  | string | ✅       | Min 8 characters   |

**Response — `201 Created`:**

```json
{ "id": 1 }
```

**Sets cookies:**

- `accessToken` (httpOnly, sameSite: strict, 1 day)
- `refreshToken` (httpOnly, sameSite: strict, 1 year)

**Response — `400 Bad Request` (validation failure):**

```json
{
    "errors": [
        {
            "type": "field",
            "msg": "First name is required!",
            "path": "firstName",
            "location": "body"
        }
    ]
}
```

---

### `POST /auth/login`

Authenticate a user with email and password.

**Auth required:** None (public)

**Request Body** (`application/json`):

```json
{
    "email": "swarup@example.com",
    "password": "secret@123"
}
```

| Field      | Type   | Required | Validation         |
| ---------- | ------ | -------- | ------------------ |
| `email`    | string | ✅       | Valid email format |
| `password` | string | ✅       | Non-empty          |

**Response — `200 OK`:**

```json
{ "id": 1 }
```

**Sets cookies:**

- `accessToken` (httpOnly, sameSite: strict, 1 day)
- `refreshToken` (httpOnly, sameSite: strict, 1 year)

**Response — `400 Bad Request` (wrong credentials):**

```json
{
    "errors": [
        {
            "type": "UnauthorizedError",
            "message": "Email or password does not match."
        }
    ]
}
```

---

### `GET /auth/self`

Get the profile of the currently authenticated user.

**Auth required:** `accessToken` cookie

**Request Body:** None

**Response — `200 OK`:**

```json
{
    "id": 1,
    "firstName": "Swarup",
    "lastName": "Das",
    "email": "swarup@example.com",
    "role": "customer",
    "tenant": null,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

> Note: `password` field is always omitted from the response.

**Response — `401 Unauthorized`:**

```json
{
    "errors": [
        {
            "type": "UnauthorizedError",
            "message": "No authorization token was found"
        }
    ]
}
```

---

### `POST /auth/refresh`

Rotate both tokens — exchanges the existing `refreshToken` cookie for new `accessToken` and `refreshToken` cookies.

**Auth required:** `refreshToken` cookie

**Request Body:** None

**Behavior:**

- Validates the refresh token's JWT signature and checks it exists in the database
- Deletes the old refresh token from the database
- Persists a new refresh token
- Issues new `accessToken` and `refreshToken` cookies

**Response — `200 OK`:**

```json
{ "id": 1 }
```

**Sets cookies:**

- `accessToken` (new, httpOnly, 1 day)
- `refreshToken` (new, httpOnly, 1 year)

---

### `POST /auth/logout`

Log out the current user.

**Auth required:** `accessToken` cookie + `refreshToken` cookie

**Request Body:** None

**Behavior:**

- Reads `id` from the refresh token JWT (the DB record ID)
- Deletes the refresh token from the database
- Clears both `accessToken` and `refreshToken` cookies

**Response — `200 OK`:**

```json
{}
```

---

## 🏢 Tenant Endpoints

Base path: `/tenants`

> A "Tenant" represents a restaurant in the system.

---

### `POST /tenants`

Create a new restaurant tenant.

**Auth required:** `accessToken` cookie — `admin` role only

**Request Body** (`application/json`):

```json
{
    "name": "Pizza Planet",
    "address": "123 Main Street, Mumbai, Maharashtra 400001"
}
```

| Field     | Type   | Required | Validation |
| --------- | ------ | -------- | ---------- |
| `name`    | string | ✅       | Non-empty  |
| `address` | string | ✅       | Non-empty  |

**Response — `201 Created`:**

```json
{ "id": 1 }
```

**Response — `403 Forbidden`:**

```json
{
    "errors": [
        {
            "type": "ForbiddenError",
            "message": "You don't have enough permissions"
        }
    ]
}
```

---

### `GET /tenants`

Retrieve a paginated list of all tenants.

**Auth required:** None (public)

**Query Parameters:**

| Parameter     | Type   | Default | Description    |
| ------------- | ------ | ------- | -------------- |
| `currentPage` | number | `1`     | Page number    |
| `perPage`     | number | `6`     | Items per page |
| `q`           | string | `""`    | Search keyword |

**Example Request:**

```
GET /tenants?currentPage=1&perPage=6&q=pizza
```

**Response — `200 OK`:**

```json
{
    "currentPage": 1,
    "perPage": 6,
    "total": 2,
    "data": [
        {
            "id": 1,
            "name": "Pizza Planet",
            "address": "123 Main Street, Mumbai",
            "createdAt": "2024-01-01T00:00:00.000Z",
            "updatedAt": "2024-01-01T00:00:00.000Z"
        }
    ]
}
```

---

### `GET /tenants/:id`

Retrieve a single tenant by its numeric ID.

**Auth required:** `accessToken` cookie — `admin` role only

**Path Parameters:**

| Parameter | Type   | Description |
| --------- | ------ | ----------- |
| `id`      | number | Tenant ID   |

**Response — `200 OK`:**

```json
{
    "id": 1,
    "name": "Pizza Planet",
    "address": "123 Main Street, Mumbai",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

**Response — `400 Bad Request`:**

```json
{
    "errors": [{ "type": "HttpError", "message": "Tenant does not exist." }]
}
```

---

### `PATCH /tenants/:id`

Update an existing tenant.

**Auth required:** `accessToken` cookie — `admin` role only

**Path Parameters:**

| Parameter | Type   | Description |
| --------- | ------ | ----------- |
| `id`      | number | Tenant ID   |

**Request Body** (`application/json`):

```json
{
    "name": "Pizza Planet (Updated)",
    "address": "456 New Street, Delhi, India 110001"
}
```

| Field     | Type   | Required |
| --------- | ------ | -------- |
| `name`    | string | ✅       |
| `address` | string | ✅       |

**Response — `200 OK`:**

```json
{ "id": 1 }
```

---

### `DELETE /tenants/:id`

Delete a tenant by ID.

**Auth required:** `accessToken` cookie — `admin` role only

**Path Parameters:**

| Parameter | Type   | Description |
| --------- | ------ | ----------- |
| `id`      | number | Tenant ID   |

**Response — `200 OK`:**

```json
{ "id": 1 }
```

---

## 👥 User Endpoints

Base path: `/users`

> All user endpoints require `admin` role.

---

### `POST /users`

Create a new user (manager or admin) directly — bypasses self-registration.

**Auth required:** `accessToken` cookie — `admin` role only

**Request Body** (`application/json`):

```json
{
    "firstName": "Rahul",
    "lastName": "Sharma",
    "email": "rahul@pizzaplanet.com",
    "password": "manager@123",
    "role": "manager",
    "tenantId": 1
}
```

| Field       | Type   | Required | Validation                        |
| ----------- | ------ | -------- | --------------------------------- |
| `firstName` | string | ✅       | Non-empty                         |
| `lastName`  | string | ✅       | Non-empty                         |
| `email`     | string | ✅       | Valid email                       |
| `password`  | string | ✅       | Min 8 characters                  |
| `role`      | string | ✅       | `manager` or `admin`              |
| `tenantId`  | number | ⚠️       | Required when `role` is `manager` |

**Response — `201 Created`:**

```json
{ "id": 2 }
```

---

### `GET /users`

Retrieve a paginated, filterable list of all users.

**Auth required:** `accessToken` cookie — `admin` role only

**Query Parameters:**

| Parameter     | Type   | Default | Description                                    |
| ------------- | ------ | ------- | ---------------------------------------------- |
| `currentPage` | number | `1`     | Page number                                    |
| `perPage`     | number | `6`     | Items per page                                 |
| `q`           | string | `""`    | Search by name or email                        |
| `role`        | string | `""`    | Filter by role: `customer`, `manager`, `admin` |

**Example Request:**

```
GET /users?currentPage=1&perPage=6&role=manager
```

**Response — `200 OK`:**

```json
{
    "currentPage": 1,
    "perPage": 6,
    "total": 10,
    "data": [
        {
            "id": 2,
            "firstName": "Rahul",
            "lastName": "Sharma",
            "email": "rahul@pizzaplanet.com",
            "role": "manager",
            "tenant": { "id": 1, "name": "Pizza Planet" },
            "createdAt": "2024-01-01T00:00:00.000Z",
            "updatedAt": "2024-01-01T00:00:00.000Z"
        }
    ]
}
```

---

### `GET /users/:id`

Retrieve a single user by their numeric ID.

**Auth required:** `accessToken` cookie — `admin` role only

**Path Parameters:**

| Parameter | Type   | Description |
| --------- | ------ | ----------- |
| `id`      | number | User ID     |

**Response — `200 OK`:**

```json
{
    "id": 2,
    "firstName": "Rahul",
    "lastName": "Sharma",
    "email": "rahul@pizzaplanet.com",
    "role": "manager",
    "tenant": { "id": 1, "name": "Pizza Planet" },
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

**Response — `400 Bad Request`:**

```json
{
    "errors": [{ "type": "HttpError", "message": "User does not exist." }]
}
```

---

### `PATCH /users/:id`

Update an existing user.

**Auth required:** `accessToken` cookie — `admin` role only

> **Note:** Email cannot be changed (it is used as the username). Password cannot be changed via this endpoint.

**Path Parameters:**

| Parameter | Type   | Description |
| --------- | ------ | ----------- |
| `id`      | number | User ID     |

**Request Body** (`application/json`):

```json
{
    "firstName": "Rahul",
    "lastName": "Sharma",
    "email": "rahul@pizzaplanet.com",
    "role": "manager",
    "tenantId": 1
}
```

| Field       | Type   | Required | Validation                        |
| ----------- | ------ | -------- | --------------------------------- |
| `firstName` | string | ✅       | Non-empty                         |
| `lastName`  | string | ✅       | Non-empty                         |
| `email`     | string | ✅       | Valid email                       |
| `role`      | string | ✅       | Non-empty                         |
| `tenantId`  | number | ⚠️       | Required when `role` is `manager` |

**Response — `200 OK`:**

```json
{ "id": 2 }
```

---

### `DELETE /users/:id`

Delete a user by ID.

**Auth required:** `accessToken` cookie — `admin` role only

**Path Parameters:**

| Parameter | Type   | Description |
| --------- | ------ | ----------- |
| `id`      | number | User ID     |

**Response — `200 OK`:**

```json
{ "id": 2 }
```

---

## 📋 Endpoint Summary

| Method   | Endpoint         | Auth      | Role  |
| -------- | ---------------- | --------- | ----- |
| `POST`   | `/auth/register` | ❌ Public | —     |
| `POST`   | `/auth/login`    | ❌ Public | —     |
| `GET`    | `/auth/self`     | ✅ Cookie | Any   |
| `POST`   | `/auth/refresh`  | ✅ Cookie | Any   |
| `POST`   | `/auth/logout`   | ✅ Cookie | Any   |
| `POST`   | `/tenants`       | ✅ Cookie | Admin |
| `GET`    | `/tenants`       | ❌ Public | —     |
| `GET`    | `/tenants/:id`   | ✅ Cookie | Admin |
| `PATCH`  | `/tenants/:id`   | ✅ Cookie | Admin |
| `DELETE` | `/tenants/:id`   | ✅ Cookie | Admin |
| `POST`   | `/users`         | ✅ Cookie | Admin |
| `GET`    | `/users`         | ✅ Cookie | Admin |
| `GET`    | `/users/:id`     | ✅ Cookie | Admin |
| `PATCH`  | `/users/:id`     | ✅ Cookie | Admin |
| `DELETE` | `/users/:id`     | ✅ Cookie | Admin |

---

## ⚙️ Error Response Format

All errors follow this format:

```json
{
    "errors": [
        {
            "type": "HttpError | UnauthorizedError | ForbiddenError | field",
            "message": "Human-readable error message"
        }
    ]
}
```

| Status Code | Meaning                             |
| ----------- | ----------------------------------- |
| `400`       | Validation error or bad input       |
| `401`       | Missing or invalid access token     |
| `403`       | Authenticated but insufficient role |
| `404`       | Resource not found                  |
| `500`       | Internal server error               |
