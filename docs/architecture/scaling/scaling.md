# Architecture Logic

### Shared PostgreSQL stores:
- User accounts
- Authentication data
- Assigned Raspberry (rasp-a, rasp-b, ...)
- SSD utilization per Raspberry

**corebrain.fabo011-cloud.de acts as:**
- Registration entry point
- Login entry point
- Assignment controller

**During registration:**
- CoreBrain checks SSD utilization table.
- Finds Raspberry with available storage.
- Creates user in shared PostgreSQL.
- Stores assigned node (rasp-a, rasp-b, ...).
**During login:**
- User authenticates.
- System reads assigned Raspberry.
- Redirects user to:
  - corebrain.fabo011-cloud.de
  - secondbrain.fabo011-cloud.de
  - future nodes

### User always stays on the same Raspberry because:
- Their vault files are physically there.
- No file synchronization is required.
- No distributed filesystem is required.
- When SSD on rasp-a becomes full:
  - New users are assigned to rasp-b.
  - Existing users remain on rasp-a.


| code   | domain                       | total_ssd_gb | used_ssd_gb |
| ------ | ---------------------------- | ------------ | ----------- |
| rasp-a | corebrain.fabo011-cloud.de   | 1000         | 800         |
| rasp-b | secondbrain.fabo011-cloud.de | 1000         | 120         |
