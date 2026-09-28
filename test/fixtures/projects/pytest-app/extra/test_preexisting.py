from app.mod01 import value01


# Deliberately failing. Copied into tests/ and committed by the e2e helper when asked.
def test_asserts_something_false():
    assert value01(1) == 999
