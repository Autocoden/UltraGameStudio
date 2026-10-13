use super::validation::*;

#[test]
fn invalid_name_description_and_empty_body_rejected() {
    for name in [
        "Upper",
        "has_underscore",
        "-prefix",
        "trailing-",
        "a--b",
        "../bad",
        "con",
        "lpt1",
        "",
    ] {
        assert!(
            new_document(&crate::skills::test_support::skill(name, "Keep rule"), name).is_err(),
            "invalid name accepted: {name}"
        );
    }
    assert!(new_document(
        &crate::skills::test_support::skill(&"a".repeat(65), "Rule"),
        &"a".repeat(65)
    )
    .is_err());
    assert!(new_document("---\nname: valid\ndescription: Fine\n---\n", "valid").is_err());
    assert!(new_document(
        &format!(
            "---\nname: valid\ndescription: {}\n---\nBody",
            "x".repeat(1025)
        ),
        "valid"
    )
    .is_err());
    assert!(new_document(
        &crate::skills::test_support::skill("valid", "Keep rules"),
        "valid"
    )
    .is_ok());
}

#[test]
fn frontmatter_requires_real_yaml_mapping() {
    for text in [
        "---\n[name, description]\n---\nBody",
        "---\nname: [broken\ndescription: Fine\n---\nBody",
        "---\nname: valid\nname: duplicate\ndescription: Fine\n---\nBody",
    ] {
        assert!(
            document(text, None).is_err(),
            "invalid YAML must be rejected before writing"
        );
    }
    let doc = document("---\nname: 'valid'\ndescription: >-\n  Use when verifying YAML.\n  Keep valid mappings.\nmetadata:\n  hermes:\n    tags: [checks, tests]\n---\n\n# Rule\n\nKeep it.", Some("valid")).unwrap();
    assert_eq!(doc.0, "valid");
    assert!(doc.1.starts_with("Use when verifying YAML."));
}
