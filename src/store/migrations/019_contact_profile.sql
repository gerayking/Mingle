-- Where someone sits in the organization, as the chat app reports it ("Product · Product manager"),
-- read where the owner turned on member profiles (docs/spec.md 4.2). Not written by the agent.
ALTER TABLE contacts ADD COLUMN profile TEXT;
