define(["ometa/ometa-base"], (function() {
    {
        var AbstractSQLRules2SQL = undefined;
        var comparisons = ({
            "Equals": " = ",
            "EqualOrGreater": " >= ",
            "NotEquals": " != "
        })
    };
    AbstractSQLRules2SQL = objectThatDelegatesTo(OMeta, {
        "NestedIndent": function(indent) {
            var $elf = this,
                _fromIdx = this.input.idx;
            return (indent + "\t")
        },
        "Not": function(indent) {
            var $elf = this,
                _fromIdx = this.input.idx,
                nestedIndent, ruleBody, notStatement;
            nestedIndent = this._applyWithArgs("NestedIndent", indent);
            this._form((function() {
                this._applyWithArgs("exactly", "Not");
                return notStatement = this._or((function() {
                    ruleBody = this._applyWithArgs("Exists", indent);
                    return ("NOT " + ruleBody)
                }), (function() {
                    ruleBody = this._applyWithArgs("RuleBody", nestedIndent);
                    return (((("NOT (" + nestedIndent) + ruleBody) + indent) + ")")
                }))
            }));
            return notStatement
        },
        "Exists": function(indent) {
            var $elf = this,
                _fromIdx = this.input.idx,
                x, ruleBody;
            this._form((function() {
                x = this._applyWithArgs("exactly", "Exists");
                return ruleBody = this._applyWithArgs("Query", indent)
            }));
            return ("EXISTS " + ruleBody)
        },
        "Query": function(indent) {
            var $elf = this,
                _fromIdx = this.input.idx,
                origIndent, indent, nestedIndent, joins, froms, x, fields, field, select, table, from, as, ruleBody, where;
            origIndent = indent;
            indent = this._applyWithArgs("NestedIndent", indent);
            nestedIndent = this._applyWithArgs("NestedIndent", indent);
            joins = [""];
            froms = [];
            this._form((function() {
                x = this._applyWithArgs("exactly", "Query");
                return this._many((function() {
                    return this._form((function() {
                        return (function() {
                            switch (this._apply('anything')) {
                            case "Select":
                                return (function() {
                                    this._pred((select == null));
                                    fields = [];
                                    this._form((function() {
                                        return this._or((function() {
                                            this._apply("end");
                                            return fields.push("1")
                                        }), (function() {
                                            return this._many((function() {
                                                return this._form((function() {
                                                    this._applyWithArgs("exactly", "Count");
                                                    this._applyWithArgs("exactly", "*");
                                                    field = "COUNT(*)";
                                                    return fields.push(field)
                                                }))
                                            }))
                                        }))
                                    }));
                                    return select = ((indent + "SELECT ") + fields.join(", "))
                                }).call(this);
                            case "From":
                                return (function() {
                                    table = this._apply("anything");
                                    from = (("\"" + table) + "\"");
                                    this._opt((function() {
                                        as = this._apply("anything");
                                        return from = (((from + " AS \"") + as) + "\"")
                                    }));
                                    return froms.push(from)
                                }).call(this);
                            case "Where":
                                return (function() {
                                    ruleBody = this._applyWithArgs("RuleBody", indent);
                                    return where = ((indent + "WHERE ") + ruleBody)
                                }).call(this);
                            default:
                                throw fail
                            }
                        }).call(this)
                    }))
                }))
            }));
            return (((((((("(" + select) + indent) + "FROM ") + froms.join((("," + indent) + "\t"))) + joins.join(indent)) + ((where != null) ? where : "")) + origIndent) + ")")
        },
        "Field": function() {
            var $elf = this,
                _fromIdx = this.input.idx,
                field;
            this._form((function() {
                this._applyWithArgs("exactly", "Field");
                return field = this._apply("anything")
            }));
            return (("\"" + field) + "\"")
        },
        "ReferencedField": function() {
            var $elf = this,
                _fromIdx = this.input.idx,
                binding, field;
            this._form((function() {
                this._applyWithArgs("exactly", "ReferencedField");
                binding = this._apply("anything");
                return field = this._apply("anything")
            }));
            return (((("\"" + binding) + "\".\"") + field) + "\"")
        },
        "Number": function() {
            var $elf = this,
                _fromIdx = this.input.idx,
                number;
            this._form((function() {
                this._applyWithArgs("exactly", "Number");
                return number = this._apply("anything")
            }));
            return number
        },
        "Boolean": function() {
            var $elf = this,
                _fromIdx = this.input.idx,
                bool;
            this._form((function() {
                this._applyWithArgs("exactly", "Boolean");
                return bool = this._or((function() {
                    this._apply("true");
                    return (1)
                }), (function() {
                    this._apply("false");
                    return (2)
                }))
            }));
            return bool
        },
        "And": function(indent) {
            var $elf = this,
                _fromIdx = this.input.idx,
                ruleBodies;
            this._form((function() {
                this._applyWithArgs("exactly", "And");
                return ruleBodies = this._many((function() {
                    return this._applyWithArgs("RuleBody", indent)
                }))
            }));
            return ruleBodies.join(" AND ")
        },
        "Comparison": function(indent) {
            var $elf = this,
                _fromIdx = this.input.idx,
                comparison, a, b;
            this._form((function() {
                comparison = (function() {
                    switch (this._apply('anything')) {
                    case "Equals":
                        return "Equals";
                    case "EqualOrGreater":
                        return "EqualOrGreater";
                    case "NotEquals":
                        return "NotEquals";
                    default:
                        throw fail
                    }
                }).call(this);
                a = this._applyWithArgs("RuleBody", indent);
                return b = this._applyWithArgs("RuleBody", indent)
            }));
            return ((a + comparisons[comparison]) + b)
        },
        "Between": function(indent) {
            var $elf = this,
                _fromIdx = this.input.idx,
                val, a, b;
            this._form((function() {
                this._applyWithArgs("exactly", "Between");
                val = this._applyWithArgs("Comparator", indent);
                a = this._applyWithArgs("Comparator", indent);
                return b = this._applyWithArgs("Comparator", indent)
            }));
            return ((((val + " BETWEEN ") + a) + " AND ") + b)
        },
        "Comparator": function(indent) {
            var $elf = this,
                _fromIdx = this.input.idx;
            return this._or((function() {
                return this._applyWithArgs("Query", indent)
            }), (function() {
                return this._apply("Field")
            }), (function() {
                return this._apply("ReferencedField")
            }), (function() {
                return this._apply("Number")
            }), (function() {
                return this._apply("Boolean")
            }))
        },
        "RuleBody": function(indent) {
            var $elf = this,
                _fromIdx = this.input.idx;
            return this._or((function() {
                return this._applyWithArgs("Comparator", indent)
            }), (function() {
                return this._applyWithArgs("Not", indent)
            }), (function() {
                return this._applyWithArgs("Exists", indent)
            }), (function() {
                return this._applyWithArgs("Comparison", indent)
            }), (function() {
                return this._applyWithArgs("Between", indent)
            }), (function() {
                return this._applyWithArgs("And", indent)
            }))
        },
        "Process": function() {
            var $elf = this,
                _fromIdx = this.input.idx,
                ruleBody;
            ruleBody = this._applyWithArgs("RuleBody", "\n");
            return (("SELECT " + ruleBody) + " AS \"result\";")
        }
    });
    var primitives = ({
        "integer": true
    });
    return AbstractSQLRules2SQL
}))