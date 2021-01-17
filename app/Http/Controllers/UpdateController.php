<?php

namespace App\Http\Controllers;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\Process\Exception\ProcessFailedException;
use Symfony\Component\Process\Process;

class UpdateController extends Controller
{
    const SUCCESS = 0;
    const ERROR = 1;

    private $output = "";
    private $status = UpdateController::SUCCESS;

    /**
     * @param Request $request
     *
     * @return Application|ResponseFactory|Response
     */
    public function update(Request $request)
    {
        $this->output = "";
        $message      = "";

        try {
            $base_command = "cd ".base_path();

            // Pull from github
            $process = Process::fromShellCommandline("$base_command && git checkout master");
            $process->run();
            $this->output .= $this->getOutput($process);

            // Pull
            $process = Process::fromShellCommandline("$base_command && git pull");
            $process->run();
            $this->output .= $this->getOutput($process);

            // Install composer dependencies
            $process = Process::fromShellCommandline("$base_command && composer install");
            $process->run();
            $this->output .= $this->getOutput($process);

            // Install npm dependencies
            $process = Process::fromShellCommandline("$base_command && npm install");
            $process->run();
            $this->output .= $this->getOutput($process);

            // Run npm production
            $process = Process::fromShellCommandline("$base_command && npm run prod");
            $process->start();

        } catch (ProcessFailedException  $e) {
            $status  = UpdateController::ERROR;
            $message = $e->getMessage();
        }

        return response([
            "status"  => $this->status,
            "output"  => $this->output,
            "message" => $message
        ]);
    }

    /**
     * @param Process $process
     *
     * @return string
     */
    private function getOutput(Process $process)
    {
        $this->status = $process->getExitCode();
        return $process->getOutput() == "" ? $process->getErrorOutput() : $process->getOutput();
    }
}
