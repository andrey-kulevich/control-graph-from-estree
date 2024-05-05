import { negateTruthiness } from "../expressions/negator";
import { stringify } from "../expressions/stringifier";

import { parseStatement } from "./statement";

import * as ESTree from "../../estree";

import {
  createAssignmentExpression,
  createCallExpression,
  createIdentifier
} from "../../estreeFactory";

import {
  Completion,
  EnclosingStatementType,
  FlowNode,
  ParsingContext
} from "../../flow";

export { parseForOfStatement };

function parseForOfStatement(
  forOfStatement: ESTree.ForOfStatement,
  currentNode: FlowNode,
  context: ParsingContext,
  label?: string
): Completion {
  let iteratorFunctionIdentifier = createIdentifier("$$iterator");
  let iteratorCall = createCallExpression(iteratorFunctionIdentifier, [
    forOfStatement.right
  ]);

  const iteratorName = context.createTemporaryLocalVariableName("iter");
  let iteratorIdentifier = createIdentifier(iteratorName);
  let iteratorAssignment = createAssignmentExpression({
    left: iteratorIdentifier,
    right: iteratorCall
  });

  let conditionNode = context
    .createNode()
    .appendTo(currentNode, stringify(iteratorAssignment), iteratorAssignment);

  let isDoneExpression: ESTree.MemberExpression = {
    type: ESTree.NodeType.MemberExpression,
    computed: false,
    object: iteratorIdentifier,
    property: createIdentifier("done")
  };

  let isNotDoneExpression = negateTruthiness(isDoneExpression);

  let startOfLoopBody = context
    .createNode()
    .appendConditionallyTo(
      conditionNode,
      stringify(isNotDoneExpression),
      isNotDoneExpression
    );

  let finalNode = context
    .createNode()
    .appendConditionallyTo(
      conditionNode,
      stringify(isDoneExpression),
      isDoneExpression
    );

  let nextElementCallee: ESTree.MemberExpression = {
    type: ESTree.NodeType.MemberExpression,
    computed: false,
    object: iteratorIdentifier,
    property: createIdentifier("next")
  };

  let propertyAssignment = createAssignmentExpression({
    left: getLeftHandSideOfAssignment(forOfStatement),
    right: createCallExpression(nextElementCallee)
  });

  let propertyAssignmentNode = context
    .createNode()
    .appendTo(
      startOfLoopBody,
      stringify(propertyAssignment),
      propertyAssignment
    );

  context.enclosingStatements.push({
    type: EnclosingStatementType.OtherStatement,
    breakTarget: finalNode,
    continueTarget: conditionNode,
    label: label
  });

  let loopBodyCompletion = parseStatement(
    forOfStatement.body,
    propertyAssignmentNode,
    context
  );

  context.enclosingStatements.pop();

  if (loopBodyCompletion.normal) {
    conditionNode.appendEpsilonEdgeTo(loopBodyCompletion.normal);
  }

  return { normal: finalNode };
}

function getLeftHandSideOfAssignment(
  forOfStatement: ESTree.ForOfStatement
): ESTree.Expression {
  if (forOfStatement.left.type === ESTree.NodeType.VariableDeclaration) {
    let variableDeclarator = (<ESTree.VariableDeclaration>forOfStatement.left)
      .declarations[0];
    const variableName = variableDeclarator.id.name;

    return createIdentifier(variableName);
  }

  return forOfStatement.left;
}
