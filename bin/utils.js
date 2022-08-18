import yargsInteractive from 'yargs-interactive';

export async function interactiveConfirm(question, func) {
    await yargsInteractive()
        .interactive({
            confirm: {
                type: 'confirm',
                default: false,
                describe: question,
                prompt: 'always'
            },
            interactive: {
                default: true
            }
        })
        .then(async (result) => {
            if (!result.confirm) return;
            func()
        });
}