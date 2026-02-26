#!/bin/bash
sed -i 's/    res.status(204).send()/    res.status(204).send()\n})/' src/routes/auth.ts
sed -i 's/     return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions)/     return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions)\n}/' src/middleware/auth.ts
