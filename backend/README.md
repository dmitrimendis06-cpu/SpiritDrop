# SpiritDrop Backend

Hostinger Node.js API and database logic for SpiritDrop.

Planned address: `api.spiritdrop.com.au`. Database: Hostinger MariaDB/MySQL. Not built yet.

The public website and the admin portal (see `../admin`) will both use this one API and database.

Never commit credentials. Secrets belong in `backend/.env`, which Git ignores; `.env.example` may list variable names only.
