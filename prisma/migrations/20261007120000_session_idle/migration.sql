-- Sessions: when the person last did something (the storekeeper is logged out after 12 hours idle, the owner after 30 days)
-- and a counter that, when the owner resets a password, ends every session that person already has.
ALTER TABLE "users" ADD COLUMN "lastActiveAt" TIMESTAMP(3),
                    ADD COLUMN "sessionEpoch" INTEGER NOT NULL DEFAULT 0;
