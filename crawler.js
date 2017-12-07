const fs = require('fs');
const CDP = require('chrome-remote-interface');
const ChromePool = require('chrome-pool');
const fsPath = require('fs-path');
const Promise = require('bluebird');
const exec = Promise.promisify(require('child_process').exec);
var fileIndex = [];
var taskFailed = 0;
var failedUrl = [];
async function crawler(BatchNum){
  console.log("Create ChromePool");

  const chromeTabsPoll = await ChromePool.new({
      maxTab : 1000,
      port : 9222
  });
  console.log("Read index.json");
  fs.readFile('./bootstrap/index.json', (error, data)=>{

    if (error) {
      fsPath.writeFileSync('./bootstrap/index.json', JSON.stringify(fileIndex));
    } else {
      try{
        fileIndex = JSON.parse(data);
      } catch(e) {
        fileIndex = [];
      }
    }
    console.log("Read profile-urls.json");
    fs.readFile("./profile-urls.json", "utf8", async (err, fileData)=>{
      try {
        const requestWillBeSent = [], responseReceived = [];
        var entries = JSON.parse(fileData);
        var prefix = "https://public.tableau.com";

        for (let i = 0; i < entries.length;) {
          let batchNum = entries.length - i < BatchNum ? entries.length - i: BatchNum;
          let remainingRequests = [];
          console.log("Start wait");

          for (let c = i; c < i + batchNum; c++){
            try {
              let fileName = entries[c][0].replace(/\//g, '').substr(0, 100);
              if (c >= 0) {
                console.log(c);
                let finished = false;
                let url = prefix + entries[c][0];
                console.log(url);

                let views = entries[c][1];
                let ridForBootstrap;
                let { tabId, protocol } = await chromeTabsPoll.require();
                // console.log(tabId, "Required");
                let { Page, Target, Network, DOM } = protocol;
                await Network.enable();
                await Page.enable();
                protocol.setMaxListeners(2000);
                let timeout;
                let task = new Promise(async (outerRes, outerRej) => {
                  let flag = false;
                  let innerTask = new Promise((resolve, reject) => {
                      timeout = setTimeout(() => {
                        taskFailed++;
                        failedUrl.push(url);
                        console.log("1Fail", url, c);
                        resolve(false);
                        flag = true;
                        return;
                      }, 60000);
                      Network.requestWillBeSent(params => {
                          if (params.request.method === 'POST' &&
                              params.request.url.includes('bootstrapSession') &&
                             !params.request.url.includes('errors') &&
                             !flag) {
                              clearTimeout(timeout);
                              ridForBootstrap = params.requestId;
                              haveBootstrapId = true;
                              resolve(true);
                              flag = true;
                              return;
                          }
                      });
                  }).then((bootstrapId) => {
                    // console.log(tabId, bootstrapId, c);
                    if (!bootstrapId) {
                      outerRes(true);
                      return true;
                    }
                    let timeout = setTimeout(() => {
                      taskFailed++;
                      failedUrl.push(url);
                      console.log("2Fail", url, c);
                      outerRes(true);
                      return true;
                    }, 60000);
                    let flag2 = false;
                    Network.loadingFinished(({requestId})=>{
                        responseReceived.push(requestId);
                        if(requestId === ridForBootstrap && !flag2){
                            flag2 = true;
                            clearTimeout(timeout);
                            // console.log('Loading Finished',tabId, c);
                            timeout = setTimeout(() => {
                              taskFailed++;
                              failedUrl.push(url);
                              console.log("3Fail", url, c);
                              outerRes(true);
                              flag2 = true;
                              return true;
                            }, 60000);
                            let flag3 = false;
                            Network.getResponseBody({requestId}, (base64Encoded, body, error)=>{
                                if(error){
                                    throw error;
                                }
                                // console.log('GetResBody Finished', tabId, c);
                                clearTimeout(timeout);
                                if (body) {
                                  let data = body['body'];
                                  if (data) {
                                    let regx = /\}[0-9]+\;\{/g;
                                    let match;
                                    let seperator = '@$#7842@&#';
                                    while ((match = regx.exec(data)) != null) {
                                      data = data.slice(0, match.index+1) + seperator + data.slice(match.index+1);
                                    }
                                    let dataToTrim = data.split(seperator);
                                    let usefulData = [];
                                    for(let p = 0; p < dataToTrim.length; p++) {
                                      let d = dataToTrim[p];
                                      let dataId = d.slice(0, d.indexOf(';{'));
                                      if (fileIndex.indexOf(fileName) === -1 ) fileIndex.push(fileName);

                                      try {
                                        d = JSON.parse(d.slice(d.indexOf(';{') + 1));
                                        usefulData.push(d);
                                      } catch(e) {

                                      }
                                    }
                                    usefulData.push(views);
                                    try {
                                      fsPath.writeFileSync('./bootstrap/'+fileName+'.json', JSON.stringify(usefulData));
                                      // console.log("Success in tab", tabId, c);
                                    } catch(e) {
                                      console.log("Write file failed: ", e);
                                      outerRes(true);
                                      return true;
                                    }

                                  }
                                } else {
                                  console.log(url, "EMPTY");
                                }
                                outerRes(true);
                                return true;
                            });
                        }
                    });
                  });
                  await innerTask;
                }).then(() => {
                  try {
                    // console.log("Release tab", tabId);
                    chromeTabsPoll.release(tabId, false);
                  } catch (e) {
                    console.log("Release tab", tabId, "Failed");
                  }

                  return true;
                });
                remainingRequests.push(task);
                // console.log("Start query: ", url);
                Page.navigate({url:url});
              }

            } catch(e) {
              console.log("UNKOWN ERROR", c);
            }
          }


          await Promise.all(remainingRequests).then(() => console.log("Finish batch"), () => console.log("Finish batch error"));

          i = i + batchNum;
        }
        await chromeTabsPoll.destroyPoll();
        console.log("Total Fail:", taskFailed);
        fsPath.writeFileSync('./bootstrap/index.json', JSON.stringify(fileIndex));
      } catch (e) {
        console.log(e);
      }
    });
    return;
  });
  return;
};

console.log("Start");
crawler(parseInt(process.argv[2]) || 10);
// -------------------------------------ERROR HANDLER---------------------------------//
//do something when app is closing
process.on('exit', exitHandler.bind(null,{cleanup:true}));
//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {exit:true}));
// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null, {exit:true}));
process.on('SIGUSR2', exitHandler.bind(null, {exit:true}));
//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, {exit:true}));
function exitHandler(options, err) {
  console.log("Total Fail:", taskFailed);

    if (options.cleanup) console.log('clean');
    if (err) console.log(err.stack);
    fsPath.writeFile('./bootstrap/index.json', JSON.stringify(fileIndex), (err)=>{
        if(err) throw err;
        fsPath.writeFile('./bootstrap/failedUrl.json', JSON.stringify(failedUrl), (err)=>{
            if(err) throw err;
            if (options.exit) process.exit();
        });
    });
}

