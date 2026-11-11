# Windows release smoke

For each graph node invocation, execute only the command supplied in that node's `with.ask`; do not run the other smoke steps from this shared skill. Return that command's success or exact process error to the graph. On failure, stop the invocation so the graph follows its failure edge. Never retry a command within the same graph run. The graph owns the install → version → capture sequence, so capture runs only after both earlier nodes succeed.
