/// <reference path="../estree.ts" />
/// <reference path="../flow.ts" />
/// <reference path="../util/idGenerator.ts" />
/// <reference path="../collections/stack.ts" />
/// <reference path="enclosingStatement.ts" />
/// <reference path="expressions/negator.ts" />
/// <reference path="expressions/stringifier.ts" />
/// <reference path="passes/constantConditionalEdgeRewriting.ts" />
/// <reference path="passes/transitNodeRemoval.ts" />

namespace Styx.Parser {
    const stringify = Expressions.Stringifier.stringify;
    const negateTruthiness = Expressions.Negator.negateTruthiness;
    
    interface CaseBlock {
        caseClausesA: ESTree.SwitchCase[];
        defaultCase: ESTree.SwitchCase;
        caseClausesB: ESTree.SwitchCase[];
    }
    
    interface StatementTypeToParserMap {
        [type: string]: (statement: ESTree.Statement, currentNode: FlowNode) => FlowNode;
    }
    
    export function parse(program: ESTree.Program, options: ParserOptions): FlowProgram {
        return new Parser(program, options).program;
    }
    
    export class Parser {
        public program: FlowProgram;
        
        private functions: FlowFunction[];
        private currentFunction: FlowFunction;
        private enclosingStatements: Collections.Stack<EnclosingStatement>;
        
        private nodeIdGenerator = Util.createIdGenerator();
        private functionIdGenerator = Util.createIdGenerator();
        private variableNameIdGenerator = Util.createIdGenerator();
        
        constructor(program: ESTree.Program, options: ParserOptions) {
            this.functions = [];
            this.currentFunction = null;
            this.enclosingStatements = new Collections.Stack<EnclosingStatement>();
            
            this.program = this.parseProgram(program, options);
        }
    
        parseProgram(program: ESTree.Program, options: ParserOptions): FlowProgram {
            let entryNode = this.createNode(NodeType.Entry);
            let successExitNode = this.createNode(NodeType.Exit);
            
            let programFlowGraph = { entry: entryNode, successExit: successExitNode };
            
            let finalNode = this.parseStatements(program.body, entryNode);
            successExitNode.appendEpsilonEdgeTo(finalNode);
            
            // Run optimization passes
            let functionFlowGraphs = this.functions.map(func => func.flowGraph);
            let flowGraphs = [programFlowGraph, ...functionFlowGraphs];
            Parser.runOptimizationPasses(flowGraphs, options);
            
            return {
                flowGraph: programFlowGraph,
                functions: this.functions
            };
        }
    
        parseStatements(statements: ESTree.Statement[], currentNode: FlowNode): FlowNode {
            for (let statement of statements) {
                currentNode = this.parseStatement(statement, currentNode);
                
                if (Parser.isAbruptCompletion(statement)) {
                    // If we encounter an abrupt completion, normal control flow is interrupted
                    // and the following statements aren't executed
                    return currentNode;
                }
            }
            
            return currentNode;
        }
    
        parseStatement(statement: ESTree.Statement, currentNode: FlowNode): FlowNode {
            if (statement === null) {
                return currentNode;
            }
            
            let statementParsers: StatementTypeToParserMap = {
                [ESTree.NodeType.FunctionDeclaration]: this.parseFunctionDeclaration,
                [ESTree.NodeType.EmptyStatement]: this.parseEmptyStatement,
                [ESTree.NodeType.BlockStatement]: this.parseBlockStatement,
                [ESTree.NodeType.VariableDeclaration]: this.parseVariableDeclaration,
                [ESTree.NodeType.IfStatement]: this.parseIfStatement,
                [ESTree.NodeType.LabeledStatement]: this.parseLabeledStatement,
                [ESTree.NodeType.BreakStatement]: this.parseBreakStatement,
                [ESTree.NodeType.ContinueStatement]: this.parseContinueStatement,
                [ESTree.NodeType.WithStatement]: this.parseWithStatement,
                [ESTree.NodeType.SwitchStatement]: this.parseSwitchStatement,
                [ESTree.NodeType.ReturnStatement]: this.parseReturnStatement,
                [ESTree.NodeType.WhileStatement]: this.parseWhileStatement,
                [ESTree.NodeType.DoWhileStatement]: this.parseDoWhileStatement,
                [ESTree.NodeType.ForStatement]: this.parseForStatement,
                [ESTree.NodeType.ForInStatement]: this.parseForInStatement,
                [ESTree.NodeType.DebuggerStatement]: this.parseDebuggerStatement,
                [ESTree.NodeType.ExpressionStatement]: this.parseExpressionStatement
            };
            
            let parsingMethod = statementParsers[statement.type];
            
            if (!parsingMethod) {
                throw Error(`Encountered unsupported statement type '${statement.type}'`);
            }
            
            return parsingMethod.call(this, statement, currentNode);
        }
        
        parseFunctionDeclaration(functionDeclaration: ESTree.Function, currentNode: FlowNode): FlowNode {
            let entryNode = this.createNode(NodeType.Entry);
            let successExitNode = this.createNode(NodeType.Exit);
            
            let func: FlowFunction = {
                id: this.functionIdGenerator.makeNew(),
                name: functionDeclaration.id.name,
                flowGraph: { entry: entryNode, successExit: successExitNode }
            };
            
            let previousFunction = this.currentFunction;
            this.currentFunction = func;
            
            let finalNode = this.parseBlockStatement(functionDeclaration.body, entryNode);
            
            if (finalNode) {
                // If we reached this point, the function didn't end with an explicit return statement.
                // Thus, an implicit "undefined" is returned.
                let undefinedReturnValue: ESTree.Identifier = {
                    type: ESTree.NodeType.Identifier,
                    name: "undefined"
                };
                
                func.flowGraph.successExit
                    .appendTo(finalNode, "return undefined", EdgeType.AbruptCompletion, undefinedReturnValue);
            }
            
            this.functions.push(func);
            this.currentFunction = previousFunction;
            
            return currentNode;
        }
        
        parseEmptyStatement(emptyStatement: ESTree.EmptyStatement, currentNode: FlowNode): FlowNode {
            return this.createNode().appendTo(currentNode, "(empty)");
        }
        
        parseBlockStatement(blockStatement: ESTree.BlockStatement, currentNode: FlowNode): FlowNode {
            return this.parseStatements(blockStatement.body, currentNode);
        }
    
        parseVariableDeclaration(declaration: ESTree.VariableDeclaration, currentNode: FlowNode): FlowNode {
            for (let declarator of declaration.declarations) {
                let initString = stringify(declarator.init);
                let edgeLabel = `${declarator.id.name} = ${initString}`;
                currentNode = this.createNode().appendTo(currentNode, edgeLabel);
            }
    
            return currentNode;
        }
    
        parseLabeledStatement(labeledStatement: ESTree.LabeledStatement, currentNode: FlowNode): FlowNode {
            let body = labeledStatement.body;
            let label = labeledStatement.label.name;
            
            switch (body.type) {
                case ESTree.NodeType.BlockStatement:
                    let finalNode = this.createNode();
                    
                    let enclosingStatement: EnclosingStatement = {
                        breakTarget: finalNode,
                        continueTarget: null,
                        label: label
                    };
                    
                    this.enclosingStatements.push(enclosingStatement);
                    let endOfStatementBodyNode = this.parseBlockStatement(<ESTree.BlockStatement>body, currentNode);
                    this.enclosingStatements.pop();
                                        
                    return finalNode.appendEpsilonEdgeTo(endOfStatementBodyNode);
                
                case ESTree.NodeType.SwitchStatement:
                    return this.parseSwitchStatement(<ESTree.SwitchStatement>body, currentNode, label);
                    
                case ESTree.NodeType.WhileStatement:
                    return this.parseWhileStatement(<ESTree.WhileStatement>body, currentNode, label);
                
                case ESTree.NodeType.DoWhileStatement:
                    return this.parseDoWhileStatement(<ESTree.DoWhileStatement>body, currentNode, label);
                
                case ESTree.NodeType.ForStatement:
                    return this.parseForStatement(<ESTree.ForStatement>body, currentNode, label);
                
                case ESTree.NodeType.ForInStatement:
                    return this.parseForInStatement(<ESTree.ForInStatement>body, currentNode, label);
                    
                default:
                    // If we didn't encounter an enclosing statement,
                    // the label is irrelevant for control flow and we thus don't track it.
                    return this.parseStatement(body, currentNode);
            }
        }
    
        parseIfStatement(ifStatement: ESTree.IfStatement, currentNode: FlowNode): FlowNode {
            return ifStatement.alternate === null
                ? this.parseSimpleIfStatement(ifStatement, currentNode)
                : this.parseIfElseStatement(ifStatement, currentNode);
        }
    
        parseSimpleIfStatement(ifStatement: ESTree.IfStatement, currentNode: FlowNode): FlowNode {
            let negatedTest = negateTruthiness(ifStatement.test);
            
            let thenLabel = stringify(ifStatement.test);
            let elseLabel = stringify(negatedTest);
            
            let thenNode = this.createNode()
                .appendConditionallyTo(currentNode, thenLabel, ifStatement.test);
            
            let endOfThenBranch = this.parseStatement(ifStatement.consequent, thenNode);
            
            let finalNode = this.createNode()
                .appendConditionallyTo(currentNode, elseLabel, negatedTest);
            
            if (endOfThenBranch) {
                finalNode.appendEpsilonEdgeTo(endOfThenBranch);
            }
            
            return finalNode;
        }
    
        parseIfElseStatement(ifStatement: ESTree.IfStatement, currentNode: FlowNode): FlowNode {
            // Then branch
            let thenLabel = stringify(ifStatement.test);
            let thenNode = this.createNode().appendConditionallyTo(currentNode, thenLabel, ifStatement.test);
            let endOfThenBranch = this.parseStatement(ifStatement.consequent, thenNode);
            
            // Else branch
            let negatedTest = negateTruthiness(ifStatement.test);
            let elseLabel = stringify(negatedTest); 
            let elseNode = this.createNode().appendConditionallyTo(currentNode, elseLabel, negatedTest);
            let endOfElseBranch = this.parseStatement(ifStatement.alternate, elseNode);
            
            let finalNode = this.createNode();
            
            if (endOfThenBranch) {
                finalNode.appendEpsilonEdgeTo(endOfThenBranch);
            }
            
            if (endOfElseBranch) {
                finalNode.appendEpsilonEdgeTo(endOfElseBranch);
            }
            
            return finalNode;
        }
        
        parseBreakStatement(breakStatement: ESTree.BreakStatement, currentNode: FlowNode): FlowNode {
            let label = breakStatement.label ? breakStatement.label.name : void 0;
            let enclosingStatement = label
                ? this.enclosingStatements.find(statement => statement.label === label)
                : this.enclosingStatements.peek();
            
            enclosingStatement.breakTarget.appendTo(currentNode, "break", EdgeType.AbruptCompletion);
            
            return null;
        }
        
        parseContinueStatement(continueStatement: ESTree.ContinueStatement, currentNode: FlowNode): FlowNode {
            let label = continueStatement.label ? continueStatement.label.name : void 0;
            let enclosingStatement = label
                ? this.enclosingStatements.find(statement => statement.label === label)
                : this.enclosingStatements.peek();
            
            if (enclosingStatement.continueTarget === null) {
                throw new Error(`Illegal continue target detected: "${label}" does not label an enclosing iteration statement`);
            }
            
            enclosingStatement.continueTarget.appendTo(currentNode, "continue", EdgeType.AbruptCompletion);
            
            return null;
        }
        
        parseWithStatement(withStatement: ESTree.WithStatement, currentNode: FlowNode): FlowNode {
            let stringifiedExpression = stringify(withStatement.object);
            let expressionNode = this.createNode().appendTo(currentNode, stringifiedExpression); 
            
            return this.parseStatement(withStatement.body, expressionNode);
        }
        
        parseSwitchStatement(switchStatement: ESTree.SwitchStatement, currentNode: FlowNode, label?: string): FlowNode {
            const switchExpression = this.createTemporaryLocalVariableName();
            
            let stringifiedDiscriminant = stringify(switchStatement.discriminant);
            let exprRef = `${switchExpression} = ${stringifiedDiscriminant}`;
            let evaluatedDiscriminantNode = this.createNode().appendTo(currentNode, exprRef);
            
            let finalNode = this.createNode(); 
            
            this.enclosingStatements.push({
                breakTarget: finalNode,
                continueTarget: null,
                label: label
            });
            
            let { caseClausesA, defaultCase, caseClausesB } = Parser.partitionCases(switchStatement.cases);
            let caseClauses = [...caseClausesA, ...caseClausesB];
            
            let stillSearchingNode = evaluatedDiscriminantNode;
            let endOfPreviousCaseBody: FlowNode = null;
            let firstNodeOfClauseListB: FlowNode = null;
            
            for (let caseClause of caseClauses) {
                let truthyCondition = {
                    type: ESTree.NodeType.BinaryExpression,
                    left: { type: ESTree.NodeType.Identifier, name: switchExpression },
                    right: caseClause.test,
                    operator: "==="
                };
                
                let beginOfCaseBody = this.createNode()
                    .appendConditionallyTo(stillSearchingNode, stringify(truthyCondition), truthyCondition);
                
                if (caseClause === caseClausesB[0]) {
                    firstNodeOfClauseListB = beginOfCaseBody;
                }
                
                if (endOfPreviousCaseBody) {
                    // We reached the end of the case through normal control flow,
                    // which means there was no 'break' statement at the end.
                    // We therefore fall through from the previous case!
                    beginOfCaseBody.appendEpsilonEdgeTo(endOfPreviousCaseBody);
                }
                
                endOfPreviousCaseBody = this.parseStatements(caseClause.consequent, beginOfCaseBody);
                
                let falsyCondition = negateTruthiness(truthyCondition);  
                stillSearchingNode = this.createNode()
                    .appendConditionallyTo(stillSearchingNode, stringify(falsyCondition), falsyCondition);
            }
            
            if (endOfPreviousCaseBody) {
                // If the last case didn't end with an abrupt completion,
                // connect it to the final node and resume normal control flow.
                finalNode.appendEpsilonEdgeTo(endOfPreviousCaseBody);
            }
            
            if (defaultCase) {
                let endOfDefaultCaseBody = this.parseStatements(defaultCase.consequent, stillSearchingNode);
                
                if (endOfDefaultCaseBody) {
                    let nodeAfterDefaultCase = firstNodeOfClauseListB || finalNode;
                    nodeAfterDefaultCase.appendEpsilonEdgeTo(endOfDefaultCaseBody);
                }
            } else {
                // If there's no default case, the switch statements isn't necessarily exhaustive.
                // Therefore, if no match is found, no clause's statement list is executed
                // and control flow resumes normally after the switch statement.
                finalNode.appendEpsilonEdgeTo(stillSearchingNode);
            }
            
            this.enclosingStatements.pop();
            
            return finalNode;
        }
        
        static partitionCases(cases: ESTree.SwitchCase[]): CaseBlock {
            let caseClausesA: ESTree.SwitchCase[] = [];
            let defaultCase: ESTree.SwitchCase = null;
            let caseClausesB: ESTree.SwitchCase[] = [];
            
            let isInCaseClausesA = true;
            
            for (let switchCase of cases) {
                if (switchCase.test === null) {
                    // We found the default case
                    defaultCase = switchCase;
                    isInCaseClausesA = false;
                } else {
                    (isInCaseClausesA ? caseClausesA : caseClausesB).push(switchCase);
                }
            }
            
            return { caseClausesA, defaultCase, caseClausesB };
        }
        
        parseReturnStatement(returnStatement: ESTree.ReturnStatement, currentNode: FlowNode): FlowNode {
            let returnLabel = "return " + stringify(returnStatement.argument);
            
            this.currentFunction.flowGraph.successExit
                .appendTo(currentNode, returnLabel, EdgeType.AbruptCompletion, returnStatement.argument);
            
            return null;
        }
        
        parseWhileStatement(whileStatement: ESTree.WhileStatement, currentNode: FlowNode, label?: string): FlowNode {
            // Truthy test (enter loop)
            let truthyCondition = whileStatement.test;
            let truthyConditionLabel = stringify(truthyCondition);
            
            // Falsy test (exit loop)
            let falsyCondition = negateTruthiness(truthyCondition);
            let falsyConditionLabel = stringify(falsyCondition);
            
            let loopBodyNode = this.createNode().appendConditionallyTo(currentNode, truthyConditionLabel, truthyCondition);
            let finalNode = this.createNode();
            
            this.enclosingStatements.push({
                continueTarget: currentNode,
                breakTarget: finalNode,
                label: label
            });
            
            let endOfLoopBodyNode = this.parseStatement(whileStatement.body, loopBodyNode);
            
            if (endOfLoopBodyNode) {
                currentNode.appendEpsilonEdgeTo(endOfLoopBodyNode);
            }
            
            this.enclosingStatements.pop();
            
            return finalNode
                .appendConditionallyTo(currentNode, falsyConditionLabel, falsyCondition);
        }
        
        parseDoWhileStatement(doWhileStatement: ESTree.DoWhileStatement, currentNode: FlowNode, label?: string): FlowNode {
            // Truthy test (enter loop)
            let truthyCondition = doWhileStatement.test;
            let truthyConditionLabel = stringify(truthyCondition);
            
            // Falsy test (exit loop)
            let falsyCondition = negateTruthiness(truthyCondition);            
            let falsyConditionLabel = stringify(falsyCondition);
            
            let testNode = this.createNode();
            let finalNode = this.createNode();
            
            this.enclosingStatements.push({
                continueTarget: testNode,
                breakTarget: finalNode,
                label: label
            });
            
            let endOfLoopBodyNode = this.parseStatement(doWhileStatement.body, currentNode);
            
            this.enclosingStatements.pop();
            
            currentNode.appendConditionallyTo(testNode, truthyConditionLabel, truthyCondition);
            finalNode.appendConditionallyTo(testNode, falsyConditionLabel, falsyCondition);
            
            if (endOfLoopBodyNode) {
                testNode.appendEpsilonEdgeTo(endOfLoopBodyNode);
            }
            
            return finalNode;
        }
        
        parseForStatement(forStatement: ESTree.ForStatement, currentNode: FlowNode, label?: string): FlowNode {
            // Parse initialization
            let testDecisionNode = this.parseStatement(forStatement.init, currentNode);
            
            // Create nodes for loop cornerstones
            let beginOfLoopBodyNode = this.createNode();
            let updateNode = this.createNode();
            let finalNode = this.createNode();
            
            if (forStatement.test) {
                // If the loop has a test expression,
                // we need to add truthy and falsy edges
                let truthyCondition = forStatement.test;
                let falsyCondition = negateTruthiness(truthyCondition);
                
                // Create edges labels
                let truthyConditionLabel = stringify(truthyCondition);                
                let falsyConditionLabel = stringify(falsyCondition);
                
                // Add truthy and falsy edges
                beginOfLoopBodyNode.appendConditionallyTo(testDecisionNode, truthyConditionLabel, truthyCondition)
                finalNode.appendConditionallyTo(testDecisionNode, falsyConditionLabel, falsyCondition);
            } else {
                // If the loop doesn't have a test expression,
                // the loop body starts unconditionally after the initialization
                beginOfLoopBodyNode.appendEpsilonEdgeTo(testDecisionNode);
            }
            
            // Begin loop context
            this.enclosingStatements.push({
                continueTarget: updateNode,
                breakTarget: finalNode,
                label: label
            });
            
            // Parse body
            let endOfLoopBodyNode = this.parseStatement(forStatement.body, beginOfLoopBodyNode);
            
            // End loop context
            this.enclosingStatements.pop();
            
            if (forStatement.update) {
                // If the loop has an update expression,
                // parse it and append it to the end of the loop body
                let endOfUpdateNode = this.parseExpression(forStatement.update, updateNode);
                testDecisionNode.appendEpsilonEdgeTo(endOfUpdateNode);                                   
            } else {
                // If the loop doesn't have an update expression,
                // treat the update node as a dummy and point it to the test node
                testDecisionNode.appendEpsilonEdgeTo(updateNode);
            }
            
            if (endOfLoopBodyNode) {
                // If we reached the end of the loop body through normal control flow,
                // continue regularly with the update
                updateNode.appendEpsilonEdgeTo(endOfLoopBodyNode);
            }
            
            return finalNode;
        }
        
        parseForInStatement(forInStatement: ESTree.ForInStatement, currentNode: FlowNode, label?: string): FlowNode {
            let stringifiedRight = stringify(forInStatement.right);
            
            let variableDeclarator = forInStatement.left.declarations[0];
            let variableName = variableDeclarator.id.name;
            
            let conditionNode = this.createNode()
                .appendTo(currentNode, stringifiedRight);
            
            let startOfLoopBody = this.createNode()
                .appendConditionallyTo(conditionNode, `${variableName} = <next>`, forInStatement.right);
                
            let finalNode = this.createNode()
                .appendConditionallyTo(conditionNode, "<no more>", null);
            
            this.enclosingStatements.push({
                breakTarget: finalNode,
                continueTarget: conditionNode,
                label: label
            });
            
            let endOfLoopBody = this.parseStatement(forInStatement.body, startOfLoopBody);
            
            this.enclosingStatements.pop();
            
            if (endOfLoopBody) {
                conditionNode.appendEpsilonEdgeTo(endOfLoopBody);
            }
            
            return finalNode;
        }
        
        parseDebuggerStatement(debuggerStatement: ESTree.DebuggerStatement, currentNode: FlowNode): FlowNode {
            return currentNode;
        }
        
        parseExpressionStatement(expressionStatement: ESTree.ExpressionStatement, currentNode: FlowNode): FlowNode {
            return this.parseExpression(expressionStatement.expression, currentNode);
        }
        
        parseExpression(expression: ESTree.Expression, currentNode: FlowNode): FlowNode {
            if (expression.type === ESTree.NodeType.SequenceExpression) {
                return this.parseSequenceExpression(<ESTree.SequenceExpression>expression, currentNode);
            }
            
            let expressionLabel = stringify(expression);
            
            return this.createNode()
                .appendTo(currentNode, expressionLabel);
        }
        
        parseSequenceExpression(sequenceExpression: ESTree.SequenceExpression, currentNode: FlowNode): FlowNode {
            for (let expression of sequenceExpression.expressions) {
                currentNode = this.parseExpression(expression, currentNode);
            }
            
            return currentNode;
        }
        
        static isAbruptCompletion(statement: ESTree.Statement): boolean {
            switch (statement.type) {
                case ESTree.NodeType.BreakStatement:
                case ESTree.NodeType.ContinueStatement:
                case ESTree.NodeType.ReturnStatement:
                    return true;
                    
                default:
                    return false;
            }
        }
        
        static runOptimizationPasses(graphs: ControlFlowGraph[], options: ParserOptions) {
            for (let graph of graphs) {
                if (options.passes.rewriteConstantConditionalEdges) {
                    Passes.rewriteConstantConditionalEdges(graph.entry);
                }
                
                if (options.passes.removeTransitNodes) {
                    Passes.removeTransitNodes(graph.entry);
                }
            }
        }
        
        createTemporaryLocalVariableName(): string {
            let id = this.variableNameIdGenerator.makeNew();
            
            return `$$temp${id}`;
        }
        
        createNode(type: NodeType = NodeType.Normal): FlowNode {
            let id = this.nodeIdGenerator.makeNew();
            
            return new FlowNode(id, type);
        }
    }
}
