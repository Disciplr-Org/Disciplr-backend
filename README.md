# Disciplr Backend

Backend API for the Disciplr platform with persistent audit logging and admin query capabilities.

## Features

- **Persistent Audit Logging**: All user actions are logged to PostgreSQL with proper indexing
- **Admin Query Interface**: Efficient admin endpoints for audit log retrieval with pagination
- **Security**: Role-based authentication and authorization
- **Performance**: Optimized database queries with composite indexes
- **Comprehensive Testing**: 95%+ test coverage with security and performance tests

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- npm or yarn

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/Disciplr-Org/Disciplr-backend.git
   cd Disciplr-backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your database URL and JWT secret
   ```

4. **Set up the database**
   ```bash
   # Create database
   createdb disciplr_db
   
   # Run migrations
   npm run db:migrate
   
   # Generate Prisma client
   npm run db:generate
   ```

5. **Start the development server**
   ```bash
   npm run dev
   ```

The API will be available at `http://localhost:3000`

## API Documentation

### Health Check

```
GET /health
```

Returns the health status of the API.

### Admin Audit Logs

#### Get Audit Logs

```
GET /api/admin/audit-logs
Authorization: Bearer <admin-jwt-token>
```

Query Parameters:
- `actorUserId` (optional): Filter by user ID
- `action` (optional): Filter by action type
- `resource` (optional): Filter by resource type
- `startDate` (optional): ISO date string for start of date range
- `endDate` (optional): ISO date string for end of date range
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 50, max: 100)

#### Get Single Audit Log

```
GET /api/admin/audit-logs/:id
Authorization: Bearer <admin-jwt-token>
```

## Database Schema

### Users Table

| Column | Type | Description |
|--------|------|-------------|
| id | String | Primary key (CUID) |
| email | String | Unique email address |
| password | String | Hashed password |
| role | String | User role (user/admin) |
| createdAt | DateTime | Account creation timestamp |
| updatedAt | DateTime | Last update timestamp |

### Audit Logs Table

| Column | Type | Description |
|--------|------|-------------|
| id | String | Primary key (CUID) |
| actorUserId | String | Foreign key to users table |
| action | String | Action performed (e.g., USER_LOGIN) |
| resource | String | Resource type (e.g., auth, user) |
| resourceId | String | Specific resource ID |
| metadata | JSON | Additional event metadata |
| ipAddress | String | Client IP address |
| userAgent | String | Client user agent |
| createdAt | DateTime | Event timestamp |

### Database Indexes

- `actorUserId` - Fast filtering by user
- `action` - Fast filtering by action type  
- `createdAt` - Fast sorting and date queries
- `actorUserId, createdAt` - User activity over time
- `action, createdAt` - Action trends over time

## Development

### Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm test` - Run test suite
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report
- `npm run db:migrate` - Run database migrations
- `npm run db:generate` - Generate Prisma client
- `npm run db:studio` - Open Prisma Studio

### Project Structure

```
src/
├── lib/
│   └── audit-logs.ts          # Audit logging functions
├── middleware/
│   └── auth.ts                # Authentication middleware
├── routes/
│   └── admin.ts               # Admin API routes
├── tests/
│   ├── audit-logs.test.ts     # Audit log tests
│   ├── admin-routes.test.ts   # Admin route tests
│   └── setup.ts              # Test setup
└── index.ts                   # Application entry point

prisma/
├── schema.prisma              # Database schema
└── migrations/                # Database migrations

docs/
└── audit-logs.md              # Detailed audit log documentation
```

## Security

### Authentication

- JWT-based authentication
- Role-based access control
- Admin-only access to audit logs

### Data Protection

- Passwords are hashed using bcrypt
- Sensitive data is never stored in audit metadata
- IP addresses and user agents are logged for security

### Input Validation

- All inputs are validated using Zod schemas
- SQL injection protection via Prisma ORM
- Rate limiting considerations for admin endpoints

## Testing

The project includes comprehensive tests:

- **Unit Tests**: Core functionality testing
- **Integration Tests**: API endpoint testing
- **Security Tests**: Authentication and authorization
- **Performance Tests**: Query efficiency validation

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- audit-logs.test.ts
```

### Test Coverage

Target: 95%+ coverage for all audit log related code paths.

## Performance

### Query Performance

With proper indexing, typical query performance:
- Simple filters: < 50ms
- Date range queries: < 100ms
- Composite filters: < 150ms
- Pagination: < 200ms

### Monitoring

Monitor these metrics:
- Query latency
- Database connection pool usage
- Audit log write success rate
- Storage growth rate

## Deployment

### Environment Variables

Required environment variables:

```env
DATABASE_URL="postgresql://username:password@localhost:5432/disciplr_db"
JWT_SECRET="your-super-secret-jwt-key"
PORT=3000
NODE_ENV="production"
```

### Production Setup

1. **Set up production database**
2. **Configure environment variables**
3. **Run database migrations**
4. **Build the application**
5. **Deploy with process manager (PM2, Docker, etc.)**

### Docker Support

```dockerfile
# Example Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:

1. Check the [audit logs documentation](docs/audit-logs.md)
2. Review existing GitHub issues
3. Create a new issue with detailed information
4. Contact the development team for urgent matters
