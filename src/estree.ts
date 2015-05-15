module ESTree {
    export class NodeType {
        static BlockStatement = "BlockStatement";
        static DoWhileStatement = "DoWhileStatement";
        static EmptyStatement = "EmptyStatement";
        static ExpressionStatement = "ExpressionStatement";
        static ForStatement = "ForStatement";
        static Identifier = "Identifier";
        static IfStatement = "IfStatement";
        static Literal = "Literal";
        static LogicalExpression = "LogicalExpression";
        static Program = "Program";
        static SequenceExpression = "SequenceExpression";
        static UpdateExpression = "UpdateExpression";
        static VariableDeclaration = "VariableDeclaration";
        static WhileStatement = "WhileStatement";
    }
    
    
    // Node objects

    export interface Node {
        type: string;
        loc?: SourceLocation;
    }

    export interface SourceLocation {
        source?: string;
        start: Position;
        end: Position;
    }

    export interface Position {
        line: number; // >= 1
        column: number; // >= 0
    }
    
    
    // Programs

    export interface Program extends Node {
        body: Statement[];
    }


    // Statements

    export interface Statement extends Node {

    }
    
    export interface BlockStatement extends Statement {
        body: Statement[];
    }
    
    export interface ExpressionStatement extends Statement {
        expression: Expression;
    }
    
    export interface IfStatement extends Statement {
        test: Expression;
        consequent: Statement;
        alternate?: Statement;
    }
    
    export interface WhileStatement extends Statement {
        test: Expression;
        body: Statement;
    }
    
    export interface DoWhileStatement extends Statement {
        body: Statement;
        test: Expression;
    }
    
    export interface ForStatement extends Statement {
        init?: VariableDeclaration | Expression;
        test?: Expression;
        update?: Expression;
        body: Statement;
    }
    
    
    // Declarations
    
    export interface Declaration extends Statement {
        
    }
    
    export interface VariableDeclaration extends Declaration {
        declarations: VariableDeclarator[];
    }
    
    export interface VariableDeclarator extends Node {
        id: Identifier;
        init?: Expression;
    }
    
    
    // Expressions 
    
    export interface Expression extends Node {
        
    }
    
    export interface SequenceExpression extends Expression {
        expressions: Expression[];
    }
    
    export interface UpdateExpression extends Expression {
        operator: string;
        argument: Expression;
        prefix: boolean;
    }
    
    export interface LogicalExpression extends Expression {
        operator: string;
        left: Expression;
        right: Expression;
    }
    
    
    // Miscellaneous
    
    export interface Identifier extends Node, Expression {
        name: string;
    }
    
    export interface Literal extends Node, Expression {
        value?: string | boolean | number | RegExp;
    }
}
