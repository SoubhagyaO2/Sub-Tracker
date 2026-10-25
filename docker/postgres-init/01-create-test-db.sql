-- Separate database so automated tests (which reset the schema) never touch dev data.
CREATE DATABASE subcycle_test OWNER subcycle;
